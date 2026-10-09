// The Flight Deck card's active-`/goal` control: a small clickable target glyph, shown ONLY while a
// conversation has an active goal (Claude Code's native goal feature). Clicking it opens the SAME
// goal popover as the conversation composer (condition + latest reason + clear) — shared verbatim
// via GoalPopover. The popover is PORTALED so it escapes the swimlane's `overflow` clip, exactly
// like the card's other clickable openers (CardEffort, CardContext). Renders nothing when no goal
// is active, keeping idle cards clean.
//
// It also SEEDS the goal from the transcript on mount (once per run): goal state is disk-only and
// survives quit/relaunch, but this store is in-memory, so a card whose conversation was never
// opened this run would otherwise show no goal until opened. `seedActiveGoalOnce` reads it lazily,
// routed by the conversation — for one running on a paired server, the transcript is THAT
// server's (one ssh round trip per card per app run; only the goal lines travel).

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { Ico, Menu } from "../../ui/kit";
import { seedActiveGoalOnce, useActiveGoal } from "../../store/goalStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { GoalPopover } from "../conversation/GoalPopover";

export function CardGoal({ convId }: { convId: string }) {
  const goal = useActiveGoal(convId);
  const { sessionId, isCodex } = useConversationsStore(
    useShallow((s) => {
      const c = s.conversations.find((cv) => cv.id === convId);
      return { sessionId: c?.sessionId ?? null, isCodex: c?.kind === "codex" };
    }),
  );

  // Seed from disk once per run (Claude only — Codex has no `/goal`). Survives quit/relaunch.
  useEffect(() => {
    if (!isCodex) seedActiveGoalOnce(convId, sessionId);
  }, [convId, sessionId, isCodex]);

  if (!goal) return null;
  return (
    <Menu
      portal
      align="right"
      trigger={
        <button type="button" className="ag-goal" aria-label="Active goal — open to view" title="Active goal">
          <Ico name="target" className="sm" />
        </button>
      }
    >
      <GoalPopover convId={convId} goal={goal} />
    </Menu>
  );
}
