// User preferences for agent notifications. Three independently-toggleable
// channels fired when a session finishes a turn OR needs the user's attention
// (permission / question), plus which sound each of the two events plays. The
// dispatch logic lives in `src/notifications/`; this store only holds the prefs.
//
// Persisted to localStorage (same lightweight pattern as commandsStore) rather
// than the Rust core: these are pure UI prefs, not domain data, so they don't
// belong in the SQLite metadata store.
import { create } from "zustand";

const STORAGE_KEY = "tosse:notifications";

export interface NotificationPrefs {
  /** OS banner / Notification Center entry (tauri-plugin-notification). */
  systemNotification: boolean;
  /** A short sound — the master switch for the two sounds below. */
  sound: boolean;
  /** The sound of a turn that finished cleanly (ready for review) — a Flight Deck sound id
   *  (`flightdeck:…`, notifications/sound.ts), a macOS sound file id (the Rust `sound`
   *  module), or `none`. Routed by notifications/notificationSound.ts. */
  doneSound: string;
  /** The sound of an alert: a question or permission waiting, or a turn that ended on an
   *  open question or an error. Same id space as `doneSound`. */
  attentionSound: string;
  /** Loudness of both sounds; 1 = the default level, 0–2. */
  soundVolume: number;
  /** Bounce the Dock icon / flash the taskbar (request_user_attention command). */
  dockBounce: boolean;
}

// Opt-out by default: every channel on. The user silences what they don't want
// from the Settings → Notifications section. The factory sounds are the two chimes
// the app always played, so an upgrade sounds the same.
/** The factory sound of each event (ids: notifications/notificationSound.ts). */
export const FACTORY_SOUNDS = { done: "flightdeck:rise", attention: "flightdeck:fall" } as const;

const DEFAULTS: NotificationPrefs = {
  systemNotification: true,
  sound: true,
  doneSound: FACTORY_SOUNDS.done,
  attentionSound: FACTORY_SOUNDS.attention,
  soundVolume: 1,
  dockBounce: true,
};

export const SOUND_VOLUME_MIN = 0;
export const SOUND_VOLUME_MAX = 2;

/** Drop any stored field of the wrong type, so a hand-edited or older blob can never feed a
 *  number where a sound id belongs (or the reverse). */
function sanitize(raw: Partial<Record<keyof NotificationPrefs, unknown>>): Partial<NotificationPrefs> {
  const out: Partial<NotificationPrefs> = {};
  for (const key of ["systemNotification", "sound", "dockBounce"] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key] as boolean;
  }
  for (const key of ["doneSound", "attentionSound"] as const) {
    if (typeof raw[key] === "string" && raw[key]) out[key] = raw[key] as string;
  }
  const v = raw.soundVolume;
  if (typeof v === "number" && Number.isFinite(v)) {
    out.soundVolume = Math.min(SOUND_VOLUME_MAX, Math.max(SOUND_VOLUME_MIN, v));
  }
  return out;
}

function load(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added channel defaults to on for users who
    // already have a stored (older, smaller) prefs object.
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULTS;
    return { ...DEFAULTS, ...sanitize(parsed as Partial<Record<keyof NotificationPrefs, unknown>>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface NotificationsState extends NotificationPrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<NotificationPrefs>) => void;
  /** Flip the sound pref and persist — shared by the header toggle and its ⌘⇧M
   *  shortcut, neither of which has the current value handy. */
  toggleSound: () => void;
}

export const useNotifications = create<NotificationsState>((set, get) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: NotificationPrefs = {
        systemNotification: patch.systemNotification ?? s.systemNotification,
        sound: patch.sound ?? s.sound,
        doneSound: patch.doneSound ?? s.doneSound,
        attentionSound: patch.attentionSound ?? s.attentionSound,
        soundVolume: patch.soundVolume ?? s.soundVolume,
        dockBounce: patch.dockBounce ?? s.dockBounce,
      };
      save(next);
      return next;
    }),
  toggleSound: () => get().set({ sound: !get().sound }),
}));
