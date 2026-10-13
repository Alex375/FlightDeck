import { useEffect, useMemo } from "react";
import { localConversations, useFleetCounts } from "../../agent/fleet";
import { useAppErrors } from "../../store/appErrors";
import { useRunningCountsByConv } from "../../store/backgroundTasksStore";
import { useConversations, useRepos } from "../../store/conversationsStore";
import { awakeHold, releaseGraceMs, resistsLid, useCaffeinate } from "../../store/caffeinate";
import { useKeepAwakeUnavailable } from "../../store/platformLimits";
import { sleepLockStale, useSleepLock } from "../../store/sleepLock";
import { useAwakeAssertion } from "./useAwakeAssertion";
import { useBatteryGate } from "./useBatteryGate";

/**
 * The Caffeinate POLICY, mounted once globally (render-null). Watches the on/off toggle,
 * the mode, live fleet activity and (for the closed-lid modes) the battery, computes what
 * the Rust `power` service should hold right now ({@link awakeHold}: nothing / the
 * `caffeinate` assertion / that plus the system sleep flag), and pushes it via
 * {@link useAwakeAssertion} — which, in the activity-following modes, holds a little past the
 * moment the fleet goes idle ({@link releaseGraceMs}) to bridge the gap before a follow-up
 * turn reads as busy.
 *
 * Activity source = "is ANY agent working". `useFleetCounts().running` folds a running turn
 * and the `backgrounding` state, but it does NOT count a conversation whose main turn settled
 * into an attention state (needInput / error) while a background task is STILL running — that
 * conversation buckets as `needAttention`, not `running`. So we OR it with a DIRECT
 * running-background-task check (`useRunningCountsByConv`), otherwise an activity-following
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
  // A platform with no keep-awake (Linux, for now) never asks for a hold, whatever the
  // stored toggle says: Settings shows the feature greyed with the reason instead.
  const unavailable = useKeepAwakeUnavailable();
  const enabled = useCaffeinate((s) => s.enabled) && !unavailable;
  const mode = useCaffeinate((s) => s.mode);
  const batteryFloor = useCaffeinate((s) => s.batteryFloor);
  const backgroundByConv = useRunningCountsByConv();
  const convs = useConversations();
  const repos = useRepos();
  const localIds = useMemo(() => new Set(localConversations(convs, repos).map((c) => c.id)), [convs, repos]);
  const anyAgentActive =
    useFleetCounts("local").running > 0 ||
    Object.entries(backgroundByConv).some(([convId, n]) => n > 0 && localIds.has(convId));

  const lidAllowed = useBatteryGate(enabled && resistsLid(mode), batteryFloor);
  useAwakeAssertion(awakeHold(enabled, mode, anyAgentActive, lidAllowed), releaseGraceMs(enabled, mode));

  // One read of the real closed-lid state at launch — for the tray/Settings, and to shout
  // the one state nothing automatic can fix: a previous run died with sleep disabled and
  // the authorization is gone, so the Mac is STILL sleepless (the launch reconcile could not
  // undo it). Everything else about that state is shown quietly in Settings.
  const status = useSleepLock((s) => s.status);
  useEffect(() => {
    void useSleepLock.getState().refresh();
  }, []);
  useEffect(() => {
    if (sleepLockStale(status)) {
      useAppErrors
        .getState()
        .pushError(
          "Sleep is still disabled from a previous Flight Deck run and the closed-lid authorization is gone — install it again (Settings → General → System) or run `sudo pmset -a disablesleep 0`.",
        );
    } else if (status?.reconcile_error) {
      // The launch reconcile failed with the authorization still in place (a transient
      // pmset/sudo failure): the awake driver's heartbeat retries the release every 30 s
      // (`releasePending` sees `owned`), and the banner says so instead of a quiet log line.
      useAppErrors
        .getState()
        .pushError(
          "Sleep was left disabled by a previous Flight Deck run and couldn't be re-enabled at launch — retrying every 30 s.",
          status.reconcile_error,
        );
    }
  }, [status]);

  return null;
}
