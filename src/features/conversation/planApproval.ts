// The Auto switch that follows a plan approval made on this Mac, held until claude has TAKEN
// that approval.
//
// Approving a plan exits plan mode; the CLI would otherwise drop to "default", so the card
// switches the conversation to "auto". It used to do so as soon as the answer was QUEUED (the
// IPC resolves then), but an approval may never be used: on a remote conversation the phone's
// rejection can win the race, a held answer is dropped at reattach when the prompt is gone, and
// claude may withdraw the prompt as the user clicks. The process then left plan mode without an
// approved plan — and could edit files. The plan's own tool_result says which answer claude
// took: the switch waits for it to read "approved". Written after that result, the mode change
// still lands after the CLI's own reset to "default" (it happens when the answer is taken).

import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { planResultDecision } from "./planStatus";

/** Approvals this Mac sent, by conversation, by the plan's tool_use id. */
const awaiting = new Map<string, Set<string>>();
let unsubscribe: (() => void) | null = null;

/** Switch `session` to Auto once the plan `toolUseId` (approved from this Mac) reads approved.
 *  A rejection, or a result of another kind, switches nothing. */
export function switchToAutoOnceApproved(session: string, toolUseId: string): void {
  const ids = awaiting.get(session) ?? new Set<string>();
  ids.add(toolUseId);
  awaiting.set(session, ids);
  settle();
  if (awaiting.size > 0 && !unsubscribe) unsubscribe = useConversationStore.subscribe(settle);
}

/** The approval was never sent (its send failed): nothing to switch for it. */
export function forgetPlanApproval(session: string, toolUseId: string): void {
  const ids = awaiting.get(session);
  if (!ids) return;
  ids.delete(toolUseId);
  if (ids.size === 0) awaiting.delete(session);
  stopWhenIdle();
}

function settle(): void {
  const sessions = useConversationStore.getState().sessions;
  for (const [session, ids] of [...awaiting]) {
    for (const toolUseId of [...ids]) {
      const result = sessions[session]?.toolResults[toolUseId];
      if (!result) continue;
      ids.delete(toolUseId);
      if (planResultDecision(result.content, result.isError) === "approved") {
        useConversationsStore.getState().setConvPermission(session, "auto");
      }
    }
    if (ids.size === 0) awaiting.delete(session);
  }
  stopWhenIdle();
}

function stopWhenIdle(): void {
  if (awaiting.size === 0 && unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
