// Wake-word trigger — the hands-free equivalent of the push-to-talk key.
//
// A wake-word detector (native; see the Rust `wake/` module — cpal capture +
// Silero VAD gate + openWakeWord inference, all local) fires when it hears the
// configured phrase. The front then reacts EXACTLY like a spoken push-to-talk:
// arm the voice session if it isn't up, then OPEN the microphone so the user can
// speak. A wake word means "start listening" — it NEVER closes the mic (that is
// what the silence guard and `end_call` are for), so re-firing while already
// listening is a harmless no-op.
//
// Split out of realtime.ts so the decision is a pure, unit-tested function: the
// one rule that could go subtly wrong — "don't react to the AGENT's own voice" —
// lives in a single place with tests, not scattered through the session manager.
// The action itself reuses realtime.ts's existing primitives (armVoiceSession +
// openMic), inventing no new session machinery.
import { armVoiceSession, openMic } from "./realtime";
import { useVoiceStore, type VoicePhase } from "./voiceStore";
import { playChime } from "../notifications/sound";

/** The inputs the wake gate reads — a plain record so it is trivially testable
 *  without the live session singletons. */
export interface WakeGateState {
  /** An OpenAI key is stored (the voice agent is usable at all). Mirrors
   *  `voiceStore.configured`; `null` = not read from the core yet. */
  configured: boolean | null;
  /** The user turned the wake word on. Rust-owned status (the always-on detector
   *  runs in the core and must start with the app), mirrored into the front. */
  enabled: boolean;
  /** The live session phase. While the agent is SPEAKING we must not react to the
   *  phrase: the always-on microphone hears the agent's own text-to-speech, and
   *  its voice is not a wake word — reacting would re-open the mic over the reply. */
  phase: VoicePhase;
}

/**
 * Should a detected wake word actually open the microphone right now? Pure — the
 * single decision point, so the self-trigger guard is defined and tested once.
 */
export function shouldFireWake(s: WakeGateState): boolean {
  if (s.configured !== true) return false; // no key → the whole voice feature is locked
  if (!s.enabled) return false; // the user has not opted in
  if (s.phase === "speaking") return false; // the agent is talking — its TTS is not a wake word
  if (s.phase === "error") return false; // a broken session won't accept a mic
  return true;
}

/**
 * React to a detected wake word: acknowledge with a short earcon, arm the session
 * if needed, then OPEN the microphone. Idempotent — opening an already-open mic
 * is a no-op, and the gate makes the whole call a no-op when it must not fire.
 *
 * `enabled` is passed in (the caller reads it from the Rust-owned wake status
 * mirror) so this module stays decoupled from where that flag is stored.
 */
export async function wakeTrigger(enabled: boolean): Promise<void> {
  const { configured, phase } = useVoiceStore.getState();
  if (!shouldFireWake({ configured, enabled, phase })) return;
  // A brief acknowledgement so the user knows the phrase landed and the mic is
  // opening — the earcon "OK Google" / "Dis Siri" play before they listen.
  playChime("done");
  // Arm first if the session is cold; a failed arm surfaces on the store and
  // openMic then no-ops (it needs a live session), so neither call throws out.
  await armVoiceSession().catch(() => {});
  await openMic();
}
