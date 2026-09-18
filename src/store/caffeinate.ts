// User preferences for the "Caffeinate" feature — keep the Mac awake while agents work.
// A tiny on/off flag plus a mode, persisted to localStorage (same lightweight pattern as
// notifications.ts / display.ts) rather than the Rust core: these are pure UI prefs, not
// domain data, so they don't belong in the SQLite metadata store.
//
// This store holds ONLY the policy inputs (enabled + mode). The mechanism (spawning /
// killing the `caffeinate` child) lives in the Rust `power` service, driven through the
// `set_awake` IPC command by CaffeinateHost, which combines these prefs with live fleet
// activity via `caffeineDesired`.
import { create } from "zustand";

const STORAGE_KEY = "tosse:caffeinate";

/** How aggressively the Mac is kept awake while Caffeinate is ON.
 *  - `light`: keep awake only while an agent is actively working — a running turn OR a
 *    running background task. Once the whole fleet has been idle for
 *    {@link LIGHT_RELEASE_GRACE_MS}, let the Mac sleep. Auto, ref-counted on fleet activity.
 *  - `hard` : keep awake permanently while ON, independent of activity — for Scheduled
 *    Tasks that may fire while nothing is running. Released only when Caffeinate is OFF. */
export type CaffeinateMode = "light" | "hard";

export interface CaffeinatePrefs {
  /** The toolbar toggle: is Caffeinate armed at all? OFF → the Mac sleeps normally. */
  enabled: boolean;
  /** Which keep-awake policy applies while {@link enabled}. See {@link CaffeinateMode}. */
  mode: CaffeinateMode;
}

// Off by default — opt-in. Light is the sensible default mode (follows activity, so it
// never keeps the Mac awake needlessly).
const DEFAULTS: CaffeinatePrefs = {
  enabled: false,
  mode: "light",
};

function load(): CaffeinatePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for existing users.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<CaffeinatePrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: CaffeinatePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

/** Pure keep-awake policy: whether the Mac should be held awake right now, given the
 *  prefs and live fleet activity. `hard` holds unconditionally while enabled; `light`
 *  holds only while something is actively running. Extracted so it can be unit-tested
 *  without React/IPC. */
export function caffeineDesired(
  enabled: boolean,
  mode: CaffeinateMode,
  anyAgentActive: boolean,
): boolean {
  if (!enabled) return false;
  return mode === "hard" || anyAgentActive;
}

/** How long Light mode keeps holding the Mac awake after the fleet goes idle.
 *
 *  "Idle" is not always idle: when a background task finishes, the CLI starts a follow-up turn
 *  on its own to handle the `<task-notification>`, but that turn only reads as busy at its
 *  first `message_start` — seconds later on a large context. The task's completion drops the
 *  activity count to zero in between, and a Mac idle past its sleep timer goes to sleep
 *  within ~5 s of the release (seen 2026-09-18: slept 1 s before the re-hold, mid-turn).
 *  The grace window bridges that gap; the cost is the Mac staying up one extra minute. */
export const LIGHT_RELEASE_GRACE_MS = 60_000;

/** Pure: how long to keep holding before a release takes effect. Only Light mode lingers —
 *  that release follows fleet activity, which has the gap above. Turning Caffeinate OFF is
 *  the user saying "let it sleep" and releases at once (so does Hard, whose only release IS
 *  being turned off). */
export function releaseGraceMs(enabled: boolean, mode: CaffeinateMode): number {
  return enabled && mode === "light" ? LIGHT_RELEASE_GRACE_MS : 0;
}

interface CaffeinateState extends CaffeinatePrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<CaffeinatePrefs>) => void;
  /** Flip the on/off flag and persist — shared by the toolbar button (no current value
   *  handy) and the Settings toggle. */
  toggleEnabled: () => void;
}

export const useCaffeinate = create<CaffeinateState>((set, get) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: CaffeinatePrefs = {
        enabled: patch.enabled ?? s.enabled,
        mode: patch.mode ?? s.mode,
      };
      save(next);
      return next;
    }),
  toggleEnabled: () => get().set({ enabled: !get().enabled }),
}));
