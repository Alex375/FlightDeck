// The shared body of the active-`/goal` popover — the ONE content rendered both by the composer's
// GoalChip (conversation view) and the Flight Deck card's CardGoal, so the two surfaces show the
// goal identically and can never drift. Header + full condition (wraps) + the evaluator's latest
// reason + a clear button. Each surface wraps this in its own `Menu` (in-flow vs portaled).
//
// Clearing sends the native `/goal clear` SILENTLY (no user bubble — see `useClearGoal`), drops the
// chip optimistically, and guards against a stale refetch flipping it back on (`beginGoalClearing`).

import { Ico } from "../../ui/kit";
import { useClearGoal } from "../../ipc/useCommands";
import { beginGoalClearing, useGoalStore } from "../../store/goalStore";
import type { GoalState } from "../../ipc/client";

/**
 * The "clear this goal" action, shared by every surface that offers it (this popover and the
 * conversation side panel), so the optimistic + guarded sequence below exists exactly once.
 */
export function useClearGoalAction(convId: string): () => void {
  const clearGoal = useClearGoal(convId);
  return () => {
    // Optimistic + guarded: arm the clear guard (freezes the null while `/goal clear` is in
    // flight, however long a cold `--resume` spawn takes), drop the goal now, then fire the
    // silent clear. `useClearGoal` settles the guard on success and rolls back on failure.
    beginGoalClearing(convId);
    useGoalStore.getState().set(convId, null);
    clearGoal.mutate();
  };
}

export function GoalPopover({ convId, goal }: { convId: string; goal: GoalState }) {
  const clear = useClearGoalAction(convId);
  return (
    <div className="cv-goal-pop">
      <div className="wf-pop-h">Active goal</div>
      <div className="cv-goal-pop-cond">{goal.condition}</div>
      {goal.reason ? <div className="cv-goal-pop-reason">{goal.reason}</div> : null}
      <button type="button" className="wf-pop-act" onClick={clear}>
        <Ico name="x" className="sm" />
        Clear goal
      </button>
    </div>
  );
}
