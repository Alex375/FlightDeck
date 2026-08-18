// Voice-agent runtime state — in-memory only (a session never survives a
// reload). The single source the header buttons, the Settings card and the
// session manager all read, so "what is the voice agent doing" has one answer.
//
// Two-layer model: `mode` (the armed "session vocale") and `micOpen` (the
// microphone, opened and closed WITHIN an armed session) are independent
// booleans; `phase` refines them for display.
import { create } from "zustand";

/** Session lifecycle for display. `armed` = session up, mic closed (the
 *  resting state of the voice mode); `listening` = mic open; `speaking` =
 *  audio playing out. */
export type VoicePhase =
  | "off"
  | "connecting"
  | "armed"
  | "listening"
  | "speaking"
  | "error";

interface VoiceState {
  phase: VoicePhase;
  /** The voice mode ("session vocale") is armed: fleet events are announced
   *  aloud and the mic opens for replies. */
  mode: boolean;
  /** The microphone is live RIGHT NOW (capture running, orange dot on). */
  micOpen: boolean;
  /** Last session error, shown on the buttons' tooltips + Settings. Cleared on
   *  the next successful start. */
  error: string | null;
  /**
   * Whether an OpenAI key is stored — the SHARED mirror of the Rust
   * `voice_agent_status` truth, written by whoever learns it (VoiceHost's
   * mount seed, the Settings card after save/remove). One synchronous source
   * for the buttons' visibility, the shortcut's inertness and the
   * announcement gate, so they can never disagree. `null` = not read yet.
   */
  configured: boolean | null;
  keyHint: string | null;
  setPhase: (phase: VoicePhase) => void;
  setMode: (mode: boolean) => void;
  setMicOpen: (micOpen: boolean) => void;
  setConfigured: (status: { configured: boolean; key_hint: string | null }) => void;
  fail: (error: string) => void;
  reset: () => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  phase: "off",
  mode: false,
  micOpen: false,
  error: null,
  configured: null,
  keyHint: null,
  setPhase: (phase) =>
    set(phase === "off" ? { phase, mode: false, micOpen: false } : { phase, error: null }),
  setMode: (mode) => set(mode ? { mode } : { mode, micOpen: false }),
  setMicOpen: (micOpen) => set({ micOpen }),
  setConfigured: (status) =>
    set({ configured: status.configured, keyHint: status.key_hint }),
  fail: (error) => set({ phase: "error", error, mode: false, micOpen: false }),
  reset: () => set({ phase: "off", error: null, mode: false, micOpen: false }),
}));
