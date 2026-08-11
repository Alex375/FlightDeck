// Bridges a conversation's LIVE derived status into its PERSISTED reminder. Pulled
// out of the event router (useGlobalSessionEvents) so the "WHEN to persist" glue —
// the feature's trickiest, order-dependent invariant — is unit-testable in
// isolation: it has no React/closure deps, reading both stores only via getState().
import { useConversationStore } from "../store/conversationStore";
import { useConversationsStore } from "../store/conversationsStore";
import {
  useBackgroundTasksStore,
  runningCountsByConv,
  runningBashCountsByConv,
} from "../store/backgroundTasksStore";
import { useDisplay } from "../store/display";
import { agentStatusForEntry } from "./useAgentStatus";
import { statusReminderKind } from "./status";

/**
 * Mirror a conversation's LIVE derived status into its PERSISTED reminder, so a
 * finished-but-unseen turn (review / error / open question) re-surfaces after the
 * process dies or the app restarts. Writes ONLY while the process is live: a null
 * handle keeps whatever was last persisted, because quitting/stopping must NOT
 * erase the reminder. `setReminder` is idempotent, so calling this on every
 * settling edge is cheap. The arrival order of the `turn_result` message and the
 * `busy → false` state event is not guaranteed by the core, so the event router
 * runs this from BOTH edges; it converges to the right value once both have landed.
 *
 * ⚠️ The status is derived from the SAME signals the visible status reads — including
 * the background-task counts and the "re-alert on background Bash" setting — so what is
 * persisted can never disagree with what the user is looking at. Deriving without them
 * would turn a clean finish made while a workflow / sub-agent is still running (green
 * `backgrounding`, nothing to review) into a persisted blue `review` that re-surfaces
 * after a restart — exactly the misleading alert `deriveAgentStatus` exists to avoid.
 */
export function syncReminderFromLive(convId: string): void {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.handle) return; // off: preserve the persisted reminder as-is
  const entry = useConversationStore.getState().sessions[convId];
  // Both counts off ONE snapshot, so the total and its Bash subset stay consistent.
  const tasks = useBackgroundTasksStore.getState().sessions;
  const status = agentStatusForEntry(
    conv.handle,
    entry,
    conv.pendingReminder,
    runningCountsByConv(tasks)[convId] ?? 0,
    runningBashCountsByConv(tasks)[convId] ?? 0,
    useDisplay.getState().alertOnBackgroundBash,
  );
  useConversationsStore.getState().setReminder(convId, statusReminderKind(status));
}
