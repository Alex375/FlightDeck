// The card's reasoning-effort control: the SAME EffortGauge slider the conversation
// composer uses, made interactive on a FlightDeck card. Reading order is the composer's
// own (shownControls) — LIVE session state while the process runs, else this
// conversation's persisted record, else the product default — so the chip never lies
// about the tier. Setting
// goes through the shared store setters (which push to the live session when one exists
// and always persist), exactly like the composer, minus the composer's Ultra-code
// full-screen blast (a composer flourish that has no place over the fleet grid).
//
// The gauge is portaled so its popover escapes the swimlane's `overflow` clip.

import { useShallow } from "zustand/react/shallow";
import { EffortGauge, type EffortLevel } from "../conversation/EffortGauge";
import { useSessionState } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { liveStateApplies, shownControls } from "../conversation/shownControls";

export function CardEffort({ convId }: { convId: string }) {
  const state = useSessionState(convId);
  const ctl = useConversationsStore(
    useShallow((s) => {
      const c = s.conversations.find((cv) => cv.id === convId);
      return {
        model: c?.model ?? null,
        effort: c?.effort ?? null,
        ultracode: c?.ultracode ?? false,
        kind: c?.kind ?? "claude",
        live: !!c?.handle,
      };
    }),
  );

  // Only surface the control once there's a known effort (live or persisted) — an
  // idle/never-configured card stays clean, matching the read-only chip it replaces.
  const live = liveStateApplies(state, ctl.live) ? state : null;
  const hasEffort =
    live?.effort != null || !!live?.ultracode || ctl.effort != null || ctl.ultracode;
  if (!hasEffort) return null;

  const { model: modelId, gauge: gaugeValue } = shownControls(state, ctl);

  const choose = (lvl: EffortLevel) => {
    const store = useConversationsStore.getState();
    // "Ultra code" is not an effort value — it's xhigh + a separate flag.
    if (lvl === "ultracode") store.setConvUltracode(convId);
    else store.setConvEffort(convId, lvl);
  };

  return <EffortGauge portal model={modelId} value={gaugeValue} onChange={choose} />;
}
