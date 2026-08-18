// Voice-agent runtime state — in-memory only (a session never survives a
// reload). The single source the header chip, the Settings card and the
// session manager all read, so "what is the voice agent doing" has one answer.
import { create } from "zustand";

/** Session lifecycle. `speaking`/`listening` are display refinements of a live
 *  session (driven by Realtime events); `saying` is a live announcement-only
 *  session (no microphone). */
export type VoicePhase =
  | "off"
  | "connecting"
  | "listening"
  | "speaking"
  | "saying"
  | "error";

interface VoiceState {
  phase: VoicePhase;
  /** Last session error, shown on the chip's tooltip + Settings. Cleared on
   *  the next successful start. */
  error: string | null;
  /** Whether the CURRENT session has the microphone (push-to-talk) or is an
   *  output-only announcement session. */
  micLive: boolean;
  setPhase: (phase: VoicePhase) => void;
  setMicLive: (micLive: boolean) => void;
  fail: (error: string) => void;
  reset: () => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  phase: "off",
  error: null,
  micLive: false,
  setPhase: (phase) => set(phase === "off" ? { phase, micLive: false } : { phase, error: null }),
  setMicLive: (micLive) => set({ micLive }),
  fail: (error) => set({ phase: "error", error, micLive: false }),
  reset: () => set({ phase: "off", error: null, micLive: false }),
}));
