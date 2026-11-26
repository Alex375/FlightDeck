// The orb shape of a conversation, read from the live store (kept out of `ActivityOrb.tsx` so the
// orb components stay store-free).
import type { OrbState } from "thinking-orbs";
import { useConversationStore } from "../../store/conversationStore";
import { activityKind } from "../../store/activity";
import { orbStateForActivity, orbStateForTaskKinds } from "../../agent/orbState";
import { isBackgroundActivity, useBackgroundTasksStore } from "../../store/backgroundTasksStore";

/** The shape of a conversation's running BACKGROUND work (`weaving` for sub-agents / workflows,
 *  `listening` for shells / monitors), or `null` when none runs — what a row shows once the turn
 *  is over and only that work continues. Same "is it running" test as the bars and counts. */
export function useBackgroundOrbStateOf(convId: string): OrbState | null {
  return useBackgroundTasksStore((s) => {
    const tasks = s.sessions[convId];
    if (!tasks) return null;
    const kinds: string[] = [];
    for (const t of Object.values(tasks)) if (isBackgroundActivity(t)) kinds.push(t.kind);
    return orbStateForTaskKinds(kinds);
  });
}

/** The orb shape for a conversation's live activity — `connecting` while its remote link is
 *  down (the same test as `remoteLinkView`), so every orb of that conversation agrees. Re-renders
 *  only when the SHAPE changes (the selector returns a string), not on every streamed token. */
export function useOrbStateOf(convId: string): OrbState {
  return useConversationStore((s) => {
    const e = s.sessions[convId];
    if (e?.state?.link && e.state.ended !== true) return "connecting";
    return orbStateForActivity(activityKind(e));
  });
}
