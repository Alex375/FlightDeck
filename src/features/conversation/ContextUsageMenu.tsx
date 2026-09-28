// The conversation's context/usage popover — plan usage + « Compact context » — behind any
// trigger. The side panel reaches it from two readings of the SAME number (the plain Context
// section's bar, and the telemetry deck's gauge); both open this, through the same
// backend-aware hook the composer's ring and the Flight Deck card's meter use, so no surface
// answers the question with an implementation of its own.

import type { ReactElement } from "react";
import { ContextUsageBody, Menu, type Ctx } from "../../ui/kit";
import { useContextData } from "../../store/contextData";
import { useBackendUsage } from "./backendUsage";

/** The fill past which a context reading turns into a warning — the threshold the composer's
 *  ring and the Flight Deck meter also turn on. */
export const CONTEXT_WARN_PCT = 70;

export function ContextUsageMenu({
  convId,
  trigger,
}: {
  convId: string;
  /** The trigger, given the current reading and whether it is past the warning threshold. */
  trigger: (ctx: Ctx, warn: boolean) => ReactElement;
}) {
  const { ctx, ready, plan } = useContextData(convId);
  const usage = useBackendUsage(convId, { enabled: ready });
  const warn = ctx.windowKnown && ctx.pct >= CONTEXT_WARN_PCT;
  return (
    // Portalled: the panel's islands scroll (an `overflow-y:auto` body), so an in-flow popover
    // would be clipped by it — the same reason the Flight Deck's meter portals.
    <Menu portal align="right" onOpen={usage.onOpenUsage} trigger={trigger(ctx, warn)}>
      <ContextUsageBody
        ctx={ctx}
        plan={usage.isCodex ? null : plan}
        onCompact={usage.onCompact}
        usage={usage.usage}
        usageLoading={usage.usageLoading}
        usageError={usage.usageError}
        usageUpdatedAt={usage.usageUpdatedAt}
        usageBackend={usage.usageBackend}
        onRefreshUsage={usage.onRefreshUsage}
      />
    </Menu>
  );
}
