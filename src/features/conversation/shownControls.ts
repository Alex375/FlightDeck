// What the model picker and the effort gauge SHOW for a conversation — one derivation
// shared by the composer and the Flight Deck card, so the two can never disagree.
//
// Two sources: the LIVE session state (what the running `claude` reports) and the
// conversation's persisted record (the user's last pick, applied at the next spawn).
// The live state only speaks for a process that is actually running. Without one it is
// either the neutral placeholder every loaded conversation gets (`ultracode: false`, a
// non-nullable boolean, so `state.ultracode ?? record` never reached the record) or the
// last word of a process that has since exited. Either way it hid the user's pick: the
// gauge could not reach Ultra code on a conversation that wasn't running yet, and a model
// or effort picked after a crash stayed invisible until the next message.

import type { SessionStatePayload } from "../../ipc/client";
import type { BackendKind } from "../../store/conversationsStore";
import { defaultEffortFor, defaultModelFor } from "../../store/modelPrefs";
import type { EffortLevel } from "./EffortGauge";

/** The persisted half: the conversation record's controls, plus whether it has a live
 *  process handle right now. */
export interface RecordedControls {
  model: string | null;
  effort: string | null;
  ultracode: boolean;
  kind: BackendKind;
  live: boolean;
}

export interface ShownControls {
  model: string;
  effort: EffortLevel;
  ultracode: boolean;
  /** The value the effort gauge sits on: "ultracode" when that tier is on. */
  gauge: EffortLevel;
}

/** Whether `state` describes a process that is running now (see the module comment). */
export function liveStateApplies(
  state: SessionStatePayload | undefined,
  live: boolean,
): state is SessionStatePayload {
  return live && !!state && !state.ended;
}

/** The controls to show: live state while the process runs, else the record, else the
 *  product default. Within a live state a field it doesn't know yet (null) still falls
 *  back to the record. Defaults are injectable for tests. */
export function shownControls(
  state: SessionStatePayload | undefined,
  rec: RecordedControls,
  defaults: { model: (k: BackendKind) => string; effort: (k: BackendKind) => EffortLevel } = {
    model: defaultModelFor,
    effort: defaultEffortFor,
  },
): ShownControls {
  const s = liveStateApplies(state, rec.live) ? state : null;
  const model = s?.model ?? rec.model ?? defaults.model(rec.kind);
  const effort = (s?.effort ?? rec.effort ?? defaults.effort(rec.kind)) as EffortLevel;
  const ultracode = s ? s.ultracode : rec.ultracode;
  return { model, effort, ultracode, gauge: ultracode ? "ultracode" : effort };
}
