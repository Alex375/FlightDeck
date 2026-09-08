// Shared derivation of a conversation's context-window fill (the number behind the
// context ring AND the FlightDeck card's context bar). Lifts the recipe that used
// to live inline in ConductorComposer so both surfaces compute it identically,
// keyed by the conversation's stable id.
import type { Ctx, PlanInfo } from "../ui/kit";
import { useSessionState } from "./conversationStore";

/** Compact token count: 29756 → "29.8k", 200000 → "200k", 1e6 → "1M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)) + "M";
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    if (k >= 999.95) return "1M"; // avoid "1000.0k" right below the 1M boundary
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + "k";
  }
  return String(n);
}

export interface ContextData {
  /** Tokens used / window, as the ring/bar consume it. */
  ctx: Ctx;
  /** True only once the WINDOW is known, i.e. `ctx` carries a real percentage — the
   *  gate for anything that draws a fill (the card meter, the ring's arc). It is NOT
   *  a gate for opening the usage popover: plan figures are account-global and must
   *  stay reachable during the first turn (see {@link contextFill}). */
  ready: boolean;
  /** Subscription rate-limit snapshot, or null when none reported. */
  plan: PlanInfo | null;
}

/**
 * Derive the ring/bar fill from the raw core figures. Pure (tested directly) — the
 * two figures arrive at DIFFERENT times and must be surfaced independently:
 *  - `tokens` lands early: the first ROOT `message_start` of a turn reports the prompt
 *    size, and a reloaded conversation gets it from the transcript;
 *  - `window` lands LATE and only live: the end-of-turn `result.modelUsage` (Codex:
 *    `modelContextWindow`) is the ONLY authoritative source — the model name does not
 *    tell 200k from 1M, and the on-disk transcript carries nothing.
 * So during a conversation's first turn — and after a reload, until the next turn ends
 * — there is a real token count but no honest percentage. Both flags say so explicitly
 * rather than letting a "—"/0 placeholder pass for a measurement.
 */
export function contextFill(tokens: number | null, window: number | null): Ctx {
  const usedKnown = tokens != null;
  const windowKnown = usedKnown && window != null && window > 0;
  return {
    pct: windowKnown ? Math.min(100, Math.round((tokens / window) * 100)) : 0,
    used: usedKnown ? fmtTokens(tokens) : "—",
    max: windowKnown ? fmtTokens(window) : "—",
    usedKnown,
    windowKnown,
  };
}

/**
 * The context fill for a conversation (by stable id). Real usage from the last
 * model call's input tokens over the model's window — both surfaced by the core in
 * SessionStatePayload.
 */
export function useContextData(convId: string): ContextData {
  const state = useSessionState(convId);
  const ctx = contextFill(state?.context_tokens ?? null, state?.context_window ?? null);
  const ready = ctx.windowKnown;
  // Percentage of plan usage is NOT in the stream — only what `rate_limit_event`
  // carries (coarse status + reset time).
  const plan: PlanInfo | null = state?.rate_limit
    ? {
        status: state.rate_limit.status,
        resetsAt: state.rate_limit.resets_at,
        limitType: state.rate_limit.limit_type,
        usingOverage: state.rate_limit.using_overage,
      }
    : null;
  return { ctx, ready, plan };
}
