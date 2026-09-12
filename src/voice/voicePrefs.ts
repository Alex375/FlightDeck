// Voice-agent preferences — localStorage, same lightweight pattern as
// permissions.ts. Everything defaults OFF: the feature costs money (Realtime
// bills per audio minute) and touches the microphone, so nothing runs until
// the user both adds an OpenAI key (Keychain, via the Rust `voice` module) and
// opts in here. The KEY itself is never in this store.
import { create } from "zustand";
import { DEFAULT_PTT, type PttShortcut } from "./pttShortcut";
import { VAD_THRESHOLD_DEFAULT, clampVadThreshold } from "./vad";

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
  /** Server-VAD amplitude threshold (0..1): how loud incoming audio must be to
   *  count as speech. Higher = LESS sensitive (ignores background noise and
   *  faint sounds); lower = picks up quieter speech. The Settings slider tunes
   *  it; it's pushed to the live session via `applyVadSettings`. See vad.ts. */
  vadThreshold: number;
  /** The OpenAI voice the agent speaks with, by catalogue key (`"marin"`,
   *  `"cedar"`, …). EMPTY = "whatever the app's default is" — the catalogue and
   *  the default both live Rust-side (`voice/mod.rs`), so storing the key only
   *  when the user actually picked one keeps a future change of default free.
   *  ⚠️ Fixed at mint time: a change lands on the NEXT session (realtime.ts
   *  re-arms an idle one so it is felt immediately). */
  voice: string;
  /** The user's own system prompt for the agent. EMPTY = the built-in default
   *  (`instructions.ts`) — clearing the box IS the reset. Applied live to an
   *  armed session (instructions, unlike the voice, can change mid-session). */
  instructions: string;
}

const DEFAULTS: VoicePrefs = {
  autoCloseSeconds: 25,
  pttShortcut: DEFAULT_PTT,
  vadThreshold: VAD_THRESHOLD_DEFAULT,
  voice: "",
  instructions: "",
};

function load(): VoicePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for existing users.
    const merged = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<VoicePrefs>) };
    // …and keep the same "empty means default" coercion the setter applies, so a
    // hand-edited or older store can't feed a null into the mint call.
    return { ...merged, voice: asText(merged.voice).trim(), instructions: asText(merged.instructions) };
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

/** A stored text pref, or `""` when it is anything but a string. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
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
        vadThreshold:
          patch.vadThreshold !== undefined
            ? clampVadThreshold(patch.vadThreshold)
            : s.vadThreshold,
        // Both text prefs are stored as strings and EMPTY means "the default":
        // coerce anything else (a null from a hand-edited store, an undefined
        // from an older build) back to that neutral value rather than letting it
        // travel on to the mint call or the session brief.
        voice: typeof patch.voice === "string" ? patch.voice.trim() : asText(s.voice),
        instructions:
          typeof patch.instructions === "string" ? patch.instructions : asText(s.instructions),
      };
      save(next);
      return next;
    }),
}));
