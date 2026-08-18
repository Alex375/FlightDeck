// Voice-agent preferences — localStorage, same lightweight pattern as
// permissions.ts. Everything defaults OFF: the feature costs money (Realtime
// bills per audio minute) and touches the microphone, so nothing runs until
// the user both adds an OpenAI key (Keychain, via the Rust `voice` module) and
// opts in here. The KEY itself is never in this store.
import { create } from "zustand";
import { DEFAULT_PTT, type PttShortcut } from "./pttShortcut";

const STORAGE_KEY = "tosse:voice";

export interface VoicePrefs {
  /** Close the MICROPHONE after this many seconds of silence — the cost/privacy
   *  guard (Realtime bills per audio minute; the armed session itself stays up,
   *  it exchanges no audio while the mic is closed). */
  autoCloseSeconds: number;
  /** The push-to-talk key (default: a clean tap of Right ⌘) — customizable in
   *  Settings, matched by VoiceHost's listener (see pttShortcut.ts). It toggles
   *  the mic, arming the session first when pressed from cold. */
  pttShortcut: PttShortcut;
}

const DEFAULTS: VoicePrefs = {
  autoCloseSeconds: 25,
  pttShortcut: DEFAULT_PTT,
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
        autoCloseSeconds:
          patch.autoCloseSeconds !== undefined
            ? clampAutoClose(patch.autoCloseSeconds)
            : s.autoCloseSeconds,
        pttShortcut: patch.pttShortcut ?? s.pttShortcut,
      };
      save(next);
      return next;
    }),
}));
