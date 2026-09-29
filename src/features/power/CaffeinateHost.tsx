import { useMemo } from "react";
import { localConversations, useFleetCounts } from "../../agent/fleet";
import { useRunningCountsByConv } from "../../store/backgroundTasksStore";
import { useConversations, useRepos } from "../../store/conversationsStore";
import { caffeineDesired, releaseGraceMs, useCaffeinate } from "../../store/caffeinate";
import { useAwakeAssertion } from "./useAwakeAssertion";

/**
 * The Caffeinate POLICY, mounted once globally (render-null). Watches the on/off toggle,
 * the Light/Hard mode and live fleet activity, computes whether the Mac should be held
 * awake right now, and pushes that boolean to the Rust `power` service via
 * {@link useAwakeAssertion} — which, in Light mode, holds a little past the moment the fleet
 * goes idle ({@link releaseGraceMs}) to bridge the gap before a follow-up turn reads as busy.
 *
 * Activity source for Light mode = "is ANY agent working". `useFleetCounts().running` folds
 * a running turn and the `backgrounding` state, but it does NOT count a conversation whose
 * main turn settled into an attention state (needInput / error) while a background task is
 * STILL running — that conversation buckets as `needAttention`, not `running`. So we OR it
 * with a DIRECT running-background-task check (`useRunningCountsByConv`), otherwise Light
 * mode would let the Mac sleep and stall a background sub-agent — exactly what the feature
 * exists to prevent.
 *
 * LOCAL agents only: a conversation on a remote server runs its `claude` there, under
 * `flightdeckd`, and keeps working while this Mac sleeps — the phone reaches it through the
 * relay without the Mac, and the conversation reattaches (and replays what it missed) when
 * the Mac wakes. Holding a laptop awake for work it is not doing was the costliest thing the
 * remote feature did to the battery.
 *
 * Its own component (not folded into App) so this subscription re-renders in isolation on
 * every fleet tick.
 */
export function CaffeinateHost() {
  const enabled = useCaffeinate((s) => s.enabled);
  const mode = useCaffeinate((s) => s.mode);
  const backgroundByConv = useRunningCountsByConv();
  const convs = useConversations();
  const repos = useRepos();
  const localIds = useMemo(() => new Set(localConversations(convs, repos).map((c) => c.id)), [convs, repos]);
  const anyAgentActive =
    useFleetCounts("local").running > 0 ||
    Object.entries(backgroundByConv).some(([convId, n]) => n > 0 && localIds.has(convId));

  useAwakeAssertion(caffeineDesired(enabled, mode, anyAgentActive), releaseGraceMs(enabled, mode));

  return null;
}
