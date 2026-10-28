// User preferences for the "Caffeinate" feature — keep the Mac awake while agents work.
// A tiny on/off flag plus a mode, persisted to localStorage (same lightweight pattern as
// notifications.ts / display.ts) rather than the Rust core: these are pure UI prefs, not
// domain data, so they don't belong in the SQLite metadata store.
//
// This store holds ONLY the policy inputs (enabled + mode + battery floor). The mechanisms
// (the `caffeinate` child for an open lid, the `pmset disablesleep` system flag for a closed
// one) live in the Rust `power` service, driven through the `set_awake` /
// `set_sleep_disabled` IPC commands by CaffeinateHost, which combines these prefs with live
// fleet activity and the battery reading via `awakeHold`.
import { create } from "zustand";
import type { PowerSource } from "../ipc/client";
import { MACHINE } from "../ui/platform";

const STORAGE_KEY = "tosse:caffeinate";

/** How aggressively the Mac is kept awake while Caffeinate is ON. Two axes, four presets:
 *  - WHEN it holds: `light`/`nightwatch` follow fleet activity (a running turn or a running
 *    background task; released {@link LIGHT_RELEASE_GRACE_MS} after the whole fleet goes idle),
 *    `hard`/`insomnia` hold permanently while ON (for Scheduled Tasks that fire while idle).
 *  - WHAT it survives: `light`/`hard` use the `caffeinate` assertion (lid OPEN only — macOS
 *    treats a lid close as sleep no assertion can override); `nightwatch`/`insomnia` disable
 *    sleep system-wide (`pmset disablesleep`), which survives a CLOSED lid, needs a one-time
 *    admin authorization, and is paused under the battery floor. */
export type CaffeinateMode = "light" | "hard" | "nightwatch" | "insomnia";

export const CAFFEINATE_MODES: readonly CaffeinateMode[] = ["light", "hard", "nightwatch", "insomnia"];

export function isCaffeinateMode(v: unknown): v is CaffeinateMode {
  return typeof v === "string" && (CAFFEINATE_MODES as readonly string[]).includes(v);
}

/** The hold follows fleet activity (released when idle) rather than being permanent. */
export function followsActivity(mode: CaffeinateMode): boolean {
  return mode === "light" || mode === "nightwatch";
}

/** The hold survives a closed lid (system-wide sleep disable, not a `caffeinate` assertion). */
export function resistsLid(mode: CaffeinateMode): boolean {
  return mode === "nightwatch" || mode === "insomnia";
}

/** The same keep-awake policy without the closed-lid part (Night Watch → Light, Insomnia →
 *  Hard). Where a closed-lid mode falls back to when it can no longer be delivered (the admin
 *  authorization was removed, or is missing when a saved mode is restored). */
export function openLidTwin(mode: CaffeinateMode): CaffeinateMode {
  if (mode === "nightwatch") return "light";
  if (mode === "insomnia") return "hard";
  return mode;
}

/** The permanent version of a mode, keeping its lid behaviour (Light → Hard, Night Watch →
 *  Insomnia). Used when something needs the Mac awake regardless of fleet activity (remote
 *  access) without silently dropping a closed-lid choice. */
export function permanentTwin(mode: CaffeinateMode): CaffeinateMode {
  if (mode === "light") return "hard";
  if (mode === "nightwatch") return "insomnia";
  return mode;
}

/** Display copy for each mode, shared by the title-bar tray menu and the Settings cards so
 *  the two never drift. `name` is the bare brand ("Night Watch"), `label` the one-liner for a
 *  menu row, `desc` the Settings card body. */
export const CAFFEINATE_MODE_META: Record<
  CaffeinateMode,
  { name: string; label: string; desc: string; lid: boolean; icon: string; warning?: string }
> = {
  light: {
    name: "Light",
    label: "Light — follow the agents",
    lid: false,
    icon: "coffeeLight",
    desc: `Keeps the ${MACHINE} awake only while an agent is working — a running turn or a background task. Once the whole fleet has been idle for a minute, the ${MACHINE} is free to sleep. The everyday mode: it never keeps the ${MACHINE} awake needlessly. Lid open only.`,
  },
  hard: {
    name: "Hard",
    label: "Hard — always awake",
    lid: false,
    icon: "coffeeHard",
    desc: `Keeps the ${MACHINE} awake permanently while Caffeinate is on, even when nothing is running — for Scheduled Tasks that may fire while the fleet is idle. Released only when you turn Caffeinate off. Lid open only.`,
  },
  nightwatch: {
    name: "Night Watch",
    label: "Night Watch — follow the agents, lid closed",
    lid: true,
    icon: "nightwatch",
    desc: "Light, but it survives a closed lid: sleep is disabled system-wide while an agent works, then re-enabled a minute after the fleet goes idle — or at the battery floor. Needs a one-time admin authorization.",
  },
  insomnia: {
    name: "Insomnia",
    label: "Insomnia — never sleeps, even lid closed",
    lid: true,
    icon: "insomnia",
    desc: "Disables sleep entirely while Caffeinate is on: lid closed, no agent running, on battery. Re-enabled only when you turn Caffeinate off, pick another mode, or hit the battery floor.",
    warning:
      "Not recommended: a closed Mac that never sleeps runs hot and drains its battery. Keep it plugged in and out of a bag.",
  },
};

export interface CaffeinatePrefs {
  /** The toolbar toggle: is Caffeinate armed at all? OFF → the Mac sleeps normally. */
  enabled: boolean;
  /** Which keep-awake policy applies while {@link enabled}. See {@link CaffeinateMode}. */
  mode: CaffeinateMode;
  /** Battery charge (%) under which a closed-lid mode stops disabling sleep while on battery —
   *  the Mac is then held only as Light/Hard would (lid open) until it is back above the
   *  floor plus {@link BATTERY_REARM_MARGIN}, or plugged in. */
  batteryFloor: number;
}

export const BATTERY_FLOOR_MIN = 5;
export const BATTERY_FLOOR_MAX = 50;
export const DEFAULT_BATTERY_FLOOR = 20;
/** Hysteresis above the floor before a closed-lid mode re-arms on battery, so a reading that
 *  hovers around the floor doesn't flip the system flag back and forth. */
export const BATTERY_REARM_MARGIN = 5;

// Off by default — opt-in. Light is the sensible default mode (follows activity, so it
// never keeps the Mac awake needlessly).
const DEFAULTS: CaffeinatePrefs = {
  enabled: false,
  mode: "light",
  batteryFloor: DEFAULT_BATTERY_FLOOR,
};

/** Clamp a stored floor to the allowed range; anything unreadable falls back to the default. */
export function sanitizeBatteryFloor(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v)) return DEFAULT_BATTERY_FLOOR;
  return Math.min(BATTERY_FLOOR_MAX, Math.max(BATTERY_FLOOR_MIN, v));
}

function load(): CaffeinatePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for existing users, and
    // never trust a stored mode/floor blindly (an older build may have written a shape
    // this one no longer knows).
    const stored = JSON.parse(raw) as Partial<Record<keyof CaffeinatePrefs, unknown>>;
    return {
      enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULTS.enabled,
      mode: isCaffeinateMode(stored.mode) ? stored.mode : DEFAULTS.mode,
      batteryFloor: sanitizeBatteryFloor(stored.batteryFloor),
    };
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

/** Pure keep-awake policy: whether the Mac should be held awake AT ALL right now, given the
 *  prefs and live fleet activity. Permanent modes hold unconditionally while enabled;
 *  activity-following modes hold only while something is actively running. */
export function caffeineDesired(
  enabled: boolean,
  mode: CaffeinateMode,
  anyAgentActive: boolean,
): boolean {
  if (!enabled) return false;
  return !followsActivity(mode) || anyAgentActive;
}

/** What the Rust `power` service should hold right now:
 *  - `off`: nothing — the Mac sleeps normally.
 *  - `idle`: the `caffeinate` assertion (no idle sleep; a lid close still sleeps).
 *  - `lid`: that PLUS sleep disabled system-wide (survives a closed lid). Belt and braces: the
 *    assertion stays held underneath, so if the system flag is refused or silently
 *    ineffective, the open-lid behaviour is never worse than Light/Hard.
 *  `lidAllowed` is the battery gate ({@link lidAllowedByBattery}): a closed-lid mode under the
 *  floor degrades to `idle`, never to `off`. */
export type AwakeHold = "off" | "idle" | "lid";

export function awakeHold(
  enabled: boolean,
  mode: CaffeinateMode,
  anyAgentActive: boolean,
  lidAllowed: boolean,
): AwakeHold {
  if (!caffeineDesired(enabled, mode, anyAgentActive)) return "off";
  return resistsLid(mode) && lidAllowed ? "lid" : "idle";
}

/** How long an activity-following mode keeps holding the Mac awake after the fleet goes idle.
 *
 *  "Idle" is not always idle: when a background task finishes, the CLI starts a follow-up turn
 *  on its own to handle the `<task-notification>`, but that turn only reads as busy at its
 *  first `message_start` — seconds later on a large context. The task's completion drops the
 *  activity count to zero in between, and a Mac idle past its sleep timer goes to sleep
 *  within ~5 s of the release (seen 2026-09-18: slept 1 s before the re-hold, mid-turn).
 *  The grace window bridges that gap; the cost is the Mac staying up one extra minute. */
export const LIGHT_RELEASE_GRACE_MS = 60_000;

/** Pure: how long to keep holding before a release takes effect. Only the activity-following
 *  modes (Light, Night Watch) linger — their release follows fleet activity, which has the
 *  gap above. Turning Caffeinate OFF is the user saying "let it sleep" and releases at once
 *  (so do Hard and Insomnia, whose only release IS being turned off). */
export function releaseGraceMs(enabled: boolean, mode: CaffeinateMode): number {
  return enabled && followsActivity(mode) ? LIGHT_RELEASE_GRACE_MS : 0;
}

/** Pure battery gate for the closed-lid modes, with hysteresis. `prevAllowed` is the last
 *  decision; `src` the latest reading (`null` = none yet / unreadable → keep the last
 *  decision rather than invent one). On AC the lid hold is always allowed. On battery it is
 *  cut at or under the floor and only re-armed {@link BATTERY_REARM_MARGIN} above it. A
 *  battery whose charge cannot be read never cuts the hold (the user chose the mode). */
export function lidAllowedByBattery(
  prevAllowed: boolean,
  src: PowerSource | null,
  floor: number,
): boolean {
  if (!src) return prevAllowed;
  if (!src.on_battery || src.percent == null) return true;
  return prevAllowed ? src.percent > floor : src.percent >= floor + BATTERY_REARM_MARGIN;
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
        batteryFloor:
          patch.batteryFloor === undefined ? s.batteryFloor : sanitizeBatteryFloor(patch.batteryFloor),
      };
      save(next);
      return next;
    }),
  toggleEnabled: () => get().set({ enabled: !get().enabled }),
}));
