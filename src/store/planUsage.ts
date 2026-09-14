// Real subscription usage % (5h + weekly windows). Unlike the context fill and the
// coarse rate-limit status — which ride the stream-json events into the conversation
// store — the precise percentage is NOT in the stream: it comes from the core's
// `get_plan_usage` command, which replicates the CLI's internal `GET /api/oauth/usage`.
//
// Usage is ACCOUNT-global (not per-conversation), so this is a single shared query.
// Cadence (validated with the user): a 5-min background poll, a refetch when the
// context popover opens (throttled by `staleTime`), and a manual refresh button. The
// endpoint is itself rate-limited, hence the throttling + back-off. Errors are typed
// (UsageError) and surfaced in the popover — never swallowed.

import { useQuery } from "@tanstack/react-query";
import { commands } from "../ipc/client";
import type { PlanUsage, UsageError } from "../ipc/client";

export const PLAN_USAGE_KEY = ["plan-usage"] as const;

/** Per-account query key. Usage is per SUBSCRIPTION, so two accounts must never share a
 *  cache entry — one would show the other's figures, and the auto-switch would then act
 *  on a number that belongs to the account it is trying to leave. `null` = the default
 *  (un-scoped) account. */
export const planUsageKey = (accountId: string | null) =>
  [...PLAN_USAGE_KEY, accountId ?? "default"] as const;

/** How fresh a value stays before an on-open access refetches it. Exported so the
 *  popover's on-open handler throttles against the same window. */
export const PLAN_USAGE_STALE_MS = 60_000;
const STALE_MS = PLAN_USAGE_STALE_MS;
/** Background poll cadence. */
const POLL_MS = 5 * 60_000;
/** Slower cadence while the endpoint is rate-limiting us — don't make it worse. */
const POLL_BACKOFF_MS = 15 * 60_000;

/** A cause a quick retry / soon-poll could plausibly fix. */
function isTransient(err: UsageError): boolean {
  return err.kind === "network" || err.kind === "http";
}

/** Causes a re-fetch cannot fix — stop the background poll for them (a `keychain_denied`
 *  poll would even re-trigger the macOS Keychain prompt every interval). The manual
 *  button + on-open refetch still let the user retry deliberately. */
function isTerminal(err: UsageError): boolean {
  return (
    err.kind === "no_token" ||
    err.kind === "keychain_denied" ||
    err.kind === "unauthorized" ||
    err.kind === "parse" ||
    // A removed account will not come back by polling — stop instead of retrying forever.
    err.kind === "unknown_account"
  );
}

/** Coerce any thrown value into a UsageError. The command path returns a typed
 *  UsageError, but a TRANSPORT failure (IPC/serialization/panic boundary) is re-thrown
 *  by the generated binding as a raw Error with no `.kind` — without this the popover's
 *  `kind` switch would hit `undefined` and crash. Normalizing keeps `error` always typed. */
function asUsageError(e: unknown): UsageError {
  if (e && typeof e === "object" && "kind" in e) return e as UsageError;
  return { kind: "network", detail: e instanceof Error ? e.message : String(e) };
}

/** `enabled` gates the very first fetch: pass `false` until the figure is actually
 *  reachable (the ring popover is live), so merely selecting a never-spawned conversation
 *  doesn't read the OAuth credentials / pop the macOS Keychain prompt before the user has
 *  done anything. A manual `refetch()` still works while disabled. Defaults to `true`. */
export function usePlanUsage(opts?: { enabled?: boolean; accountId?: string | null }) {
  const accountId = opts?.accountId ?? null;
  return useQuery<PlanUsage, UsageError>({
    queryKey: planUsageKey(accountId),
    enabled: opts?.enabled ?? true,
    queryFn: async (): Promise<PlanUsage> => {
      let res;
      try {
        res = await commands.getPlanUsage(accountId);
      } catch (e) {
        // Transport-level failure (not our typed Result) → normalize, never crash.
        throw asUsageError(e);
      }
      // Throw the STRUCTURED error (already a UsageError) so the popover can branch on
      // `error.kind` and show a tailored next step.
      if (res.status === "error") throw res.error;
      return res.data;
    },
    staleTime: STALE_MS,
    // The /api/oauth/usage endpoint is itself rate-limited (the CLI polls it too), so
    // back the poll WAY off once it 429s; STOP polling entirely for causes a poll can't
    // fix (and that a keychain prompt would re-trigger); normal 5-min cadence otherwise.
    refetchInterval: (query) => {
      const err = query.state.error;
      if (err?.kind === "rate_limited") return POLL_BACKOFF_MS;
      if (err && isTerminal(err)) return false;
      return POLL_MS;
    },
    // Keep polling even when the window is unfocused — usage drifts regardless.
    refetchIntervalInBackground: true,
    // Don't auto-retry causes a retry can't fix (no token, keychain denied, 401,
    // rate-limited, parse); allow one retry for a transient network / 5xx blip.
    retry: (count, error) => isTransient(error) && count < 1,
  });
}

// ---- Compile-time guard: the popover's local mirror types (ui/kit) must stay
// structurally identical to the generated IPC types. A drift (new UsageError variant,
// renamed/added field) breaks the build here instead of silently accepting a wrong
// shape at the structural call site.
import type { PlanUsageError, PlanUsageInfo, PlanUsageWindow } from "../ui/kit";
import type { UsageError as GenUsageError, UsageWindow as GenUsageWindow } from "../ipc/client";

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;
// Exported (so `noUnusedLocals` keeps it) purely to force the structural checks: any
// drift makes one of these resolve to `false`, failing `Expect<true>` → build error.
export type PlanUsageMirrorChecks = [
  Expect<Exact<PlanUsageWindow, GenUsageWindow>>,
  Expect<Exact<PlanUsageInfo, PlanUsage>>,
  Expect<Exact<PlanUsageError, GenUsageError>>,
];
