// The battery floor for the closed-lid modes: polls the power source while such a mode is
// armed and turns it into the `lidAllowed` input of `awakeHold`. Pure decision in
// `lidAllowedByBattery` (hysteresis); this hook only owns the polling and the last decision.
import { useEffect, useState } from "react";
import { commands } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import { lidAllowedByBattery } from "../../store/caffeinate";
import { useSleepLock } from "../../store/sleepLock";

/** A charge reading every minute is plenty: a battery moves a percent or two per minute at
 *  the very worst, and the floor has a 5-point re-arm margin. */
export const BATTERY_POLL_MS = 60_000;

/**
 * `true` while the closed-lid hold is allowed by the battery. Always `false` when `active` is
 * false (no closed-lid mode armed → nothing polled), and `false` until the FIRST reading
 * arrives: arming sleep-disable on a 4 % battery for the round trip of the first read — then
 * lingering a grace minute on the way down — is exactly what the floor exists to prevent.
 *
 * A failed read keeps the last decision; a failure before any decision allows the hold (the
 * user chose the mode, and refusing it forever on an unreadable battery would be a silent
 * downgrade) — and says the floor is not enforced, both in Settings and in the app banner.
 */
export function useBatteryGate(active: boolean, floor: number): boolean {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    const lock = useSleepLock.getState();
    if (!active) {
      setAllowed(null);
      lock.setPower(null);
      lock.setPowerError(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      let res: Awaited<ReturnType<typeof commands.powerSource>>;
      try {
        res = await commands.powerSource();
      } catch (e) {
        res = { status: "error", error: String(e) };
      }
      if (cancelled) return;
      if (res.status === "ok") {
        const src = res.data;
        lock.setPower(src);
        lock.setPowerError(null);
        setAllowed((prev) => lidAllowedByBattery(prev ?? true, src, floor));
      } else {
        // Keep the last reading on screen, but say it is stale.
        lock.setPowerError(res.error);
        setAllowed((prev) => prev ?? true);
        useAppErrors
          .getState()
          .pushError("Couldn't read the battery — the closed-lid battery floor isn't enforced right now.", res.error);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), BATTERY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, floor]);

  return active && allowed === true;
}
