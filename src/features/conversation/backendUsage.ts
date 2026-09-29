// Backend-aware plan-usage wiring for the context/usage popover — the ONE source
// shared by the composer's ContextRing and the Flight Deck card's clickable meter
// (CardContext), so the two surfaces can never drift apart (they used to hand-maintain
// the same isCodex branching twice, and had already drifted on onRefreshUsage).
//
// The plan figures are ACCOUNT-global, not per-conversation, and the SOURCE is
// backend-aware:
//  - Claude: the Anthropic OAuth endpoint, background-polled so the figure stays warm;
//    on open we refetch only when stale, to spare the rate-limited endpoint. Gated on
//    `!isCodex` so a Codex conversation NEVER reads Claude credentials / pops the macOS
//    Keychain — the two subscriptions (Max ≠ ChatGPT) are never mixed.
//  - Codex: the account-global store fed by the live `session_codex_plan_usage` PUSH
//    (no HTTP/Keychain surface exists), so there is nothing to poll, refetch or retry.
// Both feed the SAME `PlanUsage` shape the popover renders.
//
// The side panel's Plan usage widget reads the same sources through
// `useConversationPlanUsage` — read-only, no poller of its own — and both go through ONE
// account resolver, `useConvPlanAccount`.
import { usePlanUsage, PLAN_USAGE_STALE_MS } from "../../store/planUsage";
import { useCodexPlanUsage } from "../../store/codexPlanUsage";
import { useCodexAvailable } from "../../store/binaryAvailable";
import { useConversationsStore } from "../../store/conversationsStore";
import { useCodexCompact, useSendMessage } from "../../ipc/useCommands";
import type { PlanUsageError, PlanUsageInfo } from "../../ui/kit";

/** Everything the popover needs (ContextRing / ContextMeterMenu props), pre-branched
 *  on the conversation's backend. */
export interface BackendUsage {
  /** Whether the conversation runs on Codex — exposed for the few bits that stay at
   *  the surface (e.g. `plan={isCodex ? null : plan}`). */
  isCodex: boolean;
  usage: PlanUsageInfo | null;
  usageLoading: boolean;
  usageError: PlanUsageError | null;
  usageUpdatedAt: number | null;
  /** Labels the Plan section by backend ONLY when both backends are in play (a
   *  Codex-less setup has no ambiguity → undefined keeps the plain "Plan"). */
  usageBackend: "claude" | "codex" | undefined;
  onOpenUsage: (() => void) | undefined;
  onRefreshUsage: (() => void) | undefined;
  onCompact: () => void;
}

/** WHOSE plan a conversation's figures belong to. */
export interface ConvPlanAccount {
  /** The conversation runs on Codex: its plan is the ChatGPT one, fed by push. */
  isCodex: boolean;
  /** The Claude account whose quota applies — `null` = the default (un-scoped) account.
   *  Meaningless for Codex. */
  accountId: string | null;
  /** The conversation lives in a REMOTE (SSH) repo, so its turns are billed to the SERVER's own
   *  account — one this Mac cannot read. See {@link useConversationPlanUsage}. */
  remote: boolean;
}

/**
 * Resolve which plan (backend + account) a conversation's usage figures belong to. The ONE
 * resolver: the popover's {@link useBackendUsage} and the side panel's
 * {@link useConversationPlanUsage} both go through it, so the ring and the panel can never
 * disagree about whose quota they show.
 *
 * Three primitive selectors, never a fresh-object selector (that is the zustand infinite-render
 * footgun); the object is built outside the store.
 */
export function useConvPlanAccount(convId: string): ConvPlanAccount {
  const isCodex = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.kind === "codex",
  );
  // WHICH account's figures this conversation shows. With several accounts signed in, the
  // un-scoped query would report the default account's quota next to a conversation running on
  // another one — a plausible-looking wrong number.
  //
  // While a switch is PENDING, a live process is still billed to the account it started on:
  // show that one (`liveClaudeAccountId`), exactly like the account chip does, and only
  // follow the wanted account once there is no process to be out of step with.
  const accountId = useConversationsStore((s) => {
    const c = s.conversations.find((x) => x.id === convId);
    if (!c) return null;
    return c.handle ? (c.liveClaudeAccountId ?? null) : (c.claudeAccountId ?? null);
  });
  // Same test as the account chip: a repo with a machine is a remote one.
  const remote = useConversationsStore((s) => {
    const c = s.conversations.find((x) => x.id === convId);
    return !!(c && s.repos.find((r) => r.id === c.repoId)?.machineId);
  });
  return { isCodex, accountId, remote };
}

export function useBackendUsage(
  convId: string,
  opts: {
    /** Gates the very FIRST Claude fetch (see `usePlanUsage`) — pass the surface's
     *  "context data ready" so merely rendering never pops the Keychain. */
    enabled: boolean;
    /** Optional Claude-side "Compact context" override: the composer routes
     *  `/compact` through its own send pipeline (optimistic bubble, scroll-to-bottom).
     *  Defaults to a bare `/compact` text turn. Codex always fires its native RPC. */
    compactClaude?: () => void;
  },
): BackendUsage {
  const { isCodex, accountId } = useConvPlanAccount(convId);
  const codexAvailable = useCodexAvailable();
  const planUsage = usePlanUsage({ enabled: opts.enabled && !isCodex, accountId });
  const codexPlan = useCodexPlanUsage();
  const send = useSendMessage(convId);
  const codexCompact = useCodexCompact(convId);
  const compactClaude = opts.compactClaude ?? (() => send.mutate({ text: "/compact" }));
  return {
    isCodex,
    usage: isCodex ? codexPlan.usage : (planUsage.data ?? null),
    usageLoading: isCodex ? false : planUsage.isFetching,
    usageError: isCodex ? null : (planUsage.error ?? null),
    usageUpdatedAt: isCodex ? codexPlan.updatedAt : planUsage.dataUpdatedAt,
    usageBackend: codexAvailable ? (isCodex ? "codex" : "claude") : undefined,
    onOpenUsage: isCodex
      ? undefined // push-fed: nothing to refetch on open
      : () => {
          // Throttle against the last attempt — success OR failure — so opening the
          // popover after an error (e.g. a 429) doesn't immediately hammer the endpoint.
          const lastAttempt = Math.max(planUsage.dataUpdatedAt, planUsage.errorUpdatedAt);
          if (Date.now() - lastAttempt >= PLAN_USAGE_STALE_MS) void planUsage.refetch();
        },
    // Deliberate retry after a FAILED fetch (the error card's "Retry") —
    // meaningless for the push-fed Codex source, so absent there.
    onRefreshUsage: isCodex ? undefined : () => void planUsage.refetch(),
    // Compact the context: Codex fires the native RPC; Claude sends the `/compact` turn.
    onCompact: isCodex ? () => codexCompact.mutate() : compactClaude,
  };
}

/** A conversation's plan figures, READ-ONLY — see {@link useConversationPlanUsage}. */
export interface ConversationPlanUsage {
  backend: "claude" | "codex";
  /** Billed to a remote server's own account: nothing here describes it, so `usage` is null. */
  remote: boolean;
  /** The Claude account the figures belong to (`null` = default). Meaningless for Codex. */
  accountId: string | null;
  usage: PlanUsageInfo | null;
  /** The last fetch's failure (Claude only — the Codex push has no error channel). Kept while
   *  `usage` still holds the previous success: that pair is a STALE reading, not a fresh one. */
  error: PlanUsageError | null;
  /** A fetch is in flight — whoever started it. */
  fetching: boolean;
  /** When the shown figures were last fetched successfully / pushed (ms); `null` = never.
   *  Normalized from TanStack's `0`. */
  updatedAt: number | null;
  /** A deliberate fetch, for a click. Absent where there is nothing to fetch: Codex (push-fed)
   *  and a remote conversation (no figure of the server's account exists here). */
  refresh: (() => void) | undefined;
}

/**
 * The plan figures a conversation's side panel shows — the same source as the ring's popover,
 * read WITHOUT adding a poller.
 *
 * ⚠️ `enabled: false` is load-bearing. The TanStack poll lives on each ENABLED observer (one
 * `setInterval` per observer, only in-flight fetches deduped), and an enabled observer also
 * fetches on mount once the data is older than 60 s. A panel widget shown by default must
 * therefore only READ the cache the composer's ring, the Flight Deck cards and the context
 * popover already keep warm: no timer of its own, no fetch on mount, and so no Keychain read
 * just because the panel opened on a never-run conversation. `refresh` still fetches — only on
 * an explicit click.
 *
 * ⚠️ Remote (SSH) conversations get NO figure: their turns are billed to the server's own Claude
 * account, while the only cache this Mac has is the LOCAL default account's — a plausible number
 * that belongs to someone else. The popover's ring does not make that distinction yet.
 */
export function useConversationPlanUsage(convId: string): ConversationPlanUsage {
  const { isCodex, accountId, remote } = useConvPlanAccount(convId);
  const claude = usePlanUsage({ accountId, enabled: false });
  const codex = useCodexPlanUsage();
  const backend = isCodex ? "codex" : "claude";
  if (remote) {
    return {
      backend,
      remote: true,
      accountId,
      usage: null,
      error: null,
      fetching: false,
      updatedAt: null,
      refresh: undefined,
    };
  }
  if (isCodex) {
    return {
      backend,
      remote: false,
      accountId,
      usage: codex.usage,
      error: null,
      fetching: false,
      updatedAt: codex.updatedAt,
      refresh: undefined,
    };
  }
  return {
    backend,
    remote: false,
    accountId,
    usage: claude.data ?? null,
    error: claude.error ?? null,
    fetching: claude.isFetching,
    updatedAt: claude.dataUpdatedAt || null,
    refresh: () => void claude.refetch(),
  };
}
