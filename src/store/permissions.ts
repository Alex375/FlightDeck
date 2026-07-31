// App-wide permission policy — today a single opt-in: may a conversation be put in
// "Bypass permissions" mode at all? Persisted to localStorage (same lightweight pattern
// as notifications.ts / caffeinate.ts) rather than the Rust core: it's a user policy,
// not domain data, so it doesn't belong in the SQLite metadata store.
//
// This store holds ONLY the policy. The mechanism is the `claude` spawn flag
// `--allow-dangerously-skip-permissions`, passed by `spawnSession` (see
// conversationsStore.ensureSession) and applied in the Rust transport.
import { create } from "zustand";

const STORAGE_KEY = "tosse:permissions";

export interface PermissionPrefs {
  /** Unlock "Bypass permissions" as a selectable mode in the composer's permission menu.
   *
   *  The mode itself has always existed in the CLI, but it only STICKS when the process
   *  is spawned with `--allow-dangerously-skip-permissions` — otherwise the CLI silently
   *  downgrades it to `default`. So this flag is what makes the choice offerable, and the
   *  app passes it at spawn only while this is on.
   *
   *  ⚠️ Unlocking is not enabling: turning this on changes nothing until a conversation is
   *  explicitly switched to Bypass. Turning it OFF is immediate and total — every
   *  conversation still set to Bypass is demoted back to Default (see
   *  {@link demoteBypassConversations}), live sessions included.
   *
   *  OFF by default: an agent in bypass runs every tool without ever asking. */
  allowBypassPermissions: boolean;
}

const DEFAULTS: PermissionPrefs = {
  allowBypassPermissions: false,
};

function load(): PermissionPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for existing users.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PermissionPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: PermissionPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface PermissionState extends PermissionPrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<PermissionPrefs>) => void;
}

export const usePermissionPrefs = create<PermissionState>((set) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: PermissionPrefs = {
        allowBypassPermissions: patch.allowBypassPermissions ?? s.allowBypassPermissions,
      };
      save(next);
      return next;
    }),
}));

/** Read the current opt-in outside React (spawn path). */
export function bypassPermissionsAllowed(): boolean {
  return usePermissionPrefs.getState().allowBypassPermissions;
}

/** Why "Bypass permissions" cannot be picked for a conversation right now — a short
 *  user-facing reason — or `null` when it can.
 *
 *  Two distinct blockers, and they must not be conflated: the app-wide opt-in is off, or
 *  it is on but THIS process was spawned before it was (the unlock is a spawn flag, so a
 *  running session can never gain it). Either way the pick must be refused rather than
 *  sent: the CLI would silently downgrade it to `default` and the menu would snap back
 *  with no explanation. Pure — the composer renders the string, the tests assert it.
 *
 *  @param allowed       the app-wide opt-in (Settings → General → Permissions)
 *  @param live          is a process currently running for this conversation
 *  @param sessionAllows was THAT process spawned with the unlock flag */
export function bypassBlockedReason(
  allowed: boolean,
  live: boolean,
  sessionAllows: boolean,
): string | null {
  if (!allowed) return "Allow it in Settings → General → Permissions.";
  if (live && !sessionAllows) return "Restart this stream to unlock it.";
  return null;
}
