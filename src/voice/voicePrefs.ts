// Voice-agent preferences — localStorage, same lightweight pattern as
// permissions.ts. Everything defaults OFF: the feature costs money (Realtime
// bills per audio minute) and touches the microphone, so nothing runs until
// the user both adds an OpenAI key (Keychain, via the Rust `voice` module) and
// opts in here. The KEY itself is never in this store.
import { create } from "zustand";
import { DEFAULT_PTT, type PttShortcut } from "./pttShortcut";
import {
  VAD_EAGERNESS_DEFAULT,
  VAD_INTERRUPT_DEFAULT,
  VAD_MODE_DEFAULT,
  VAD_THRESHOLD_DEFAULT,
  asVadEagerness,
  asVadInterrupt,
  asVadMode,
  clampVadThreshold,
  type VadEagerness,
  type VadInterrupt,
  type VadMode,
  type VadSettings,
} from "./vad";

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
  /** How the session decides a turn ended: "semantic" (does it sound FINISHED)
   *  or "loudness" (is it LOUD enough). Semantic by default — a loudness gate
   *  cannot tell a plate from a word, at any threshold. See vad.ts. */
  vadMode: VadMode;
  /** Semantic mode: how eagerly the model decides you have stopped talking. */
  vadEagerness: VadEagerness;
  /** What may cut the agent off mid-sentence. Default: nothing. */
  vadInterrupt: VadInterrupt;
  /** Loudness mode: amplitude threshold (0..1). Higher = LESS sensitive. Only
   *  consulted when `vadMode` is "loudness". */
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
  vadMode: VAD_MODE_DEFAULT,
  vadEagerness: VAD_EAGERNESS_DEFAULT,
  vadInterrupt: VAD_INTERRUPT_DEFAULT,
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
    return {
      ...merged,
      voice: asText(merged.voice).trim(),
      instructions: asText(merged.instructions),
      vadMode: asVadMode(merged.vadMode),
      vadEagerness: asVadEagerness(merged.vadEagerness),
      vadInterrupt: asVadInterrupt(merged.vadInterrupt),
    };
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

/** The turn-detection settings as `vad.ts` wants them — the one place that maps
 *  the stored prefs onto the wire shape, so the two call sites in realtime.ts
 *  cannot drift apart. */
export function currentVadSettings(): VadSettings {
  const s = useVoicePrefs.getState();
  return {
    mode: asVadMode(s.vadMode),
    eagerness: asVadEagerness(s.vadEagerness),
    threshold: s.vadThreshold,
    interrupt: asVadInterrupt(s.vadInterrupt),
  };
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
        vadMode: patch.vadMode !== undefined ? asVadMode(patch.vadMode) : asVadMode(s.vadMode),
        vadEagerness:
          patch.vadEagerness !== undefined
            ? asVadEagerness(patch.vadEagerness)
            : asVadEagerness(s.vadEagerness),
        vadInterrupt:
          patch.vadInterrupt !== undefined
            ? asVadInterrupt(patch.vadInterrupt)
            : asVadInterrupt(s.vadInterrupt),
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
