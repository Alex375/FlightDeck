// Voice-agent preferences — localStorage, same lightweight pattern as
// permissions.ts. Everything defaults OFF: the feature costs money (Realtime
// bills per audio minute) and touches the microphone, so nothing runs until
// the user both adds an OpenAI key (Keychain, via the Rust `voice` module) and
// opts in here. The KEY itself is never in this store.
import { create } from "zustand";

const STORAGE_KEY = "tosse:voice";

export interface VoicePrefs {
  /** Speak fleet events aloud (turn finished / agent needs input) even when the
   *  user did not open a voice session. Output-only: an announcement session
   *  never opens the microphone. */
  announcements: boolean;
  /** Close an idle voice session after this many seconds of silence — the cost
   *  guard (Realtime bills per audio minute). */
  autoCloseSeconds: number;
}

const DEFAULTS: VoicePrefs = {
  announcements: false,
  autoCloseSeconds: 25,
};

function load(): VoicePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for existing users.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<VoicePrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: VoicePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface VoicePrefsState extends VoicePrefs {
  set: (patch: Partial<VoicePrefs>) => void;
}

/** Clamp the auto-close guard to something sane (10 s – 5 min). */
export function clampAutoClose(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULTS.autoCloseSeconds;
  return Math.min(300, Math.max(10, Math.round(seconds)));
}

export const useVoicePrefs = create<VoicePrefsState>((set) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: VoicePrefs = {
        announcements: patch.announcements ?? s.announcements,
        autoCloseSeconds:
          patch.autoCloseSeconds !== undefined
            ? clampAutoClose(patch.autoCloseSeconds)
            : s.autoCloseSeconds,
      };
      save(next);
      return next;
    }),
}));
