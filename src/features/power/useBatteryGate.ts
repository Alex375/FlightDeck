// The battery floor for the closed-lid modes: polls the power source while such a mode is
// armed and turns it into the `lidAllowed` input of `awakeHold`. Pure decision in
// `lidAllowedByBattery` (hysteresis); this hook only owns the polling and the last decision.
import { useEffect, useState } from "react";
import { commands } from "../../ipc/client";
import { lidAllowedByBattery } from "../../store/caffeinate";
import { useSleepLock } from "../../store/sleepLock";

/** A charge reading every minute is plenty: a battery moves a percent or two per minute at
 *  the very worst, and the floor has a 5-point re-arm margin. */
export const BATTERY_POLL_MS = 60_000;

/**
 * `true` while the closed-lid hold is allowed by the battery. Always `true` when `active` is
 * false (no closed-lid mode armed → nothing to gate, nothing polled). A reading that cannot
 * be taken keeps the last decision rather than inventing one.
 */
export function useBatteryGate(active: boolean, floor: number): boolean {
  const [allowed, setAllowed] = useState(true);

  useEffect(() => {
    if (!active) {
      setAllowed(true);
      useSleepLock.getState().setPower(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await commands.powerSource();
        if (cancelled) return;
        const src = res.status === "ok" ? res.data : null;
        useSleepLock.getState().setPower(src);
        setAllowed((prev) => lidAllowedByBattery(prev, src, floor));
      } catch {
        /* keep the last decision */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), BATTERY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, floor]);

  return allowed;
}
