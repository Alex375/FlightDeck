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
  const isCodex = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.kind === "codex",
  );
  // WHICH account's figures this conversation's ring shows. With several accounts signed
  // in, the un-scoped query would report the default account's quota next to a
  // conversation running on another one — a plausible-looking wrong number.
  const accountId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.claudeAccountId ?? null,
  );
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
