// What the model picker and the effort gauge SHOW for a conversation — one derivation
// shared by the composer and the Flight Deck card, so the two can never disagree.
//
// Two sources: the LIVE session state (what the running `claude` reports) and the
// conversation's persisted record (the user's last pick, applied at the next spawn).
// The live state only speaks for a process that is actually running. Without one it is
// either the neutral placeholder every loaded conversation gets (`ultracode: false`, a
// non-nullable boolean, so `state.ultracode ?? record` never reached the record) or the
// last word of a process that has since exited. Either way it hid the user's pick: the
// gauge could not show Ultracode on a conversation that wasn't running yet, and a model
// or effort picked after a crash stayed invisible until the next message.

import type { PermissionMode, SessionStatePayload } from "../../ipc/client";
import type { BackendKind } from "../../store/conversationsStore";
import { defaultEffortFor, defaultModelFor } from "../../store/modelPrefs";
import { ultracodeSupportedFor, type EffortLevel } from "./EffortGauge";
import { modelLabel } from "./models";

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
  /** Whether Ultracode is on: running now (live), or set to run at the next spawn on a
   *  model that can run it (record). Independent of the effort. */
  ultracode: boolean;
  /** Whether the Ultracode switch can be turned on. Always false on Codex. */
  ultracodeAvailable: boolean;
  /** Why it can't, in words — shown under the disabled switch. Null when available (and
   *  on Codex, which has no switch at all). */
  ultracodeUnavailableReason: string | null;
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
  if (rec.kind === "codex") {
    return { model, effort, ultracode: false, ultracodeAvailable: false, ultracodeUnavailableReason: null };
  }
  // The CLI's gate is "workflows enabled AND a model that takes xhigh". Only a live
  // read-back knows the workflows half; without one, judge the model alone.
  const modelCan = ultracodeSupportedFor(model);
  const available = s?.ultracode_available ?? modelCan;
  const ultracode = s ? s.ultracode : rec.ultracode && modelCan;
  const reason = available
    ? null
    : modelCan
      ? "Needs workflows, which are turned off (in settings or by an organization policy)."
      : `${modelLabel(model)} can't run it.`;
  return { model, effort, ultracode, ultracodeAvailable: available, ultracodeUnavailableReason: reason };
}

/** The permission mode the composer shows. While a process runs: the mode IT reports
 *  (the CLI's own word — `initialize`, each turn's `system/init`, a switch's ack — moved at
 *  once by a pick and put back if the CLI refuses it). Otherwise: the mode the next spawn
 *  will start in — the conversation's pick, else `fallback`, with "Bypass permissions"
 *  shown as Default unless the app-wide opt-in allows it, exactly as the spawn demotes it
 *  (`permission_mode_for_spawn`). Never the last word of a process that has exited: a pick
 *  made since then is what will run. */
export function shownPermissionMode(
  state: SessionStatePayload | undefined,
  live: boolean,
  recorded: string | null,
  allowBypass: boolean,
  fallback: PermissionMode,
): PermissionMode {
  const reported = liveStateApplies(state, live) ? state.permission_mode : null;
  if (reported) return reported as PermissionMode;
  const next = (recorded ?? fallback) as PermissionMode;
  return next === "bypassPermissions" && !allowBypass ? "default" : next;
}

/** Whether the RUNNING process can be switched to "Bypass permissions": what is known of
 *  THAT process — a server's daemon says it for a remote one, which may be a process this
 *  Mac did not start (a phone's); the CLI shows it by running in bypass or refusing it —
 *  else the opt-in it was spawned with. Feeds `bypassBlockedReason`'s `sessionAllows`. */
export function sessionAllowsBypass(
  state: SessionStatePayload | undefined,
  live: boolean,
  spawnedWithUnlock: boolean,
): boolean {
  const known = liveStateApplies(state, live) ? state.bypass_available : null;
  return known ?? spawnedWithUnlock;
}
