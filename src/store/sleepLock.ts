// The REAL state of the closed-lid keep-awake (`pmset disablesleep`), as last reported by the
// Rust `power` service — never the intent. The tray glyph, the Settings card and the stale
// detection read from here; writers are the awake driver (every `set_sleep_disabled` result
// carries a fresh status), the Settings Install/Remove actions, and an explicit `refresh`.
//
// Kept in memory only: the truth lives in the OS (`pmset -g`) and in the sudoers file, so
// persisting a copy could only go stale.
import { create } from "zustand";
import { commands, type PowerSource, type SleepLockStatus } from "../ipc/client";

interface SleepLockState {
  /** `null` until the first read (the UI must not claim "not authorized" before asking). */
  status: SleepLockStatus | null;
  /** The last failure of a closed-lid operation (arm, release, install…), for the Settings card. */
  lastError: string | null;
  /** The last battery / power-source reading (polled while a closed-lid mode is armed). */
  power: PowerSource | null;
  /** The last battery read failed: the floor cannot be enforced until a read succeeds. */
  powerError: string | null;
  setStatus: (status: SleepLockStatus) => void;
  setError: (error: string | null) => void;
  setPower: (power: PowerSource | null) => void;
  setPowerError: (error: string | null) => void;
  /** Re-read the real state from the core. Errors land in `lastError`, never thrown. */
  refresh: () => Promise<void>;
}

export const useSleepLock = create<SleepLockState>((set) => ({
  status: null,
  lastError: null,
  power: null,
  powerError: null,
  setStatus: (status) => set({ status }),
  setError: (lastError) => set({ lastError }),
  setPower: (power) => set({ power }),
  setPowerError: (powerError) => set({ powerError }),
  refresh: async () => {
    try {
      const res = await commands.sleepLockStatus();
      if (res.status === "ok") set({ status: res.data });
      else set({ lastError: res.error });
    } catch (e) {
      set({ lastError: String(e) });
    }
  },
}));

/** Sleep is disabled system-wide right now AND it is Flight Deck's doing. */
export function lidProofEngaged(status: SleepLockStatus | null): boolean {
  return !!status && status.system_sleep_disabled && status.owned;
}

/** A previous run died armed and the authorization is gone: the Mac is STILL sleepless and
 *  nothing automatic can fix it — the one state that must be shouted, not shown. */
export function sleepLockStale(status: SleepLockStatus | null): boolean {
  return !!status && status.owned && status.system_sleep_disabled && !status.granted;
}

/** The closed-lid modes can be offered: the feature exists here and the rule is installed.
 *  `null` status (not read yet) counts as "not yet" — the UI greys the modes with a neutral
 *  reason rather than a false "not authorized". */
export function lidModesAvailable(status: SleepLockStatus | null): boolean {
  return !!status && status.supported && status.granted;
}

/** The visible reason a closed-lid mode cannot be picked right now, or `null` when it can. */
export function lidModesBlockedReason(status: SleepLockStatus | null): string | null {
  if (!status) return "Checking the closed-lid authorization…";
  if (!status.supported) return "Closed-lid modes need macOS.";
  if (status.probe_error) return `Can't check the closed-lid authorization: ${status.probe_error}`;
  if (!status.granted) return "Needs a one-time admin authorization — Settings → General → System.";
  return null;
}
