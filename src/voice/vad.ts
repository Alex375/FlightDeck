// Turn detection for the Realtime session — deciding when the user has finished
// speaking, and when they have started (which cuts the agent off).
//
// ⚠️ THE LESSON, paid for in an unusable session (Armand, 2026-09-12): he set the
// threshold to its maximum, 0.90, and talking while emptying a dishwasher still
// cut the agent off every ten seconds — and worse, the agent ANSWERED the noise.
// Asked "shall I grant permission X?", it heard a clatter and replied "granting".
// That is a consequential action taken on crockery.
//
// A louder threshold cannot fix that, because loudness is not the problem. A
// plate on a counter IS loud; `server_vad` is an amplitude gate and has no way to
// know it carries no words. Pushing the threshold high enough to exclude dishes
// also excludes the user.
//
// `semantic_vad` is a different question asked of a different model: it chunks on
// whether the WORDS sound finished, so audio with no words in it is not a turn at
// all. It is the right default for anyone who is not sitting still in a quiet
// room, and it is now the default here. `eagerness` tunes how long it waits
// before deciding you are done — "low" lets you pause mid-sentence without being
// interrupted, which is what you want while doing something else with your hands.
//
// The loudness mode stays available, because it is the one that gives a number to
// turn when someone wants one. It is no longer the default, and Settings says
// what it is.

/** How the session decides a turn has ended. */
export type VadMode = "semantic" | "loudness";

/** How eagerly `semantic_vad` decides the user has finished speaking. */
export type VadEagerness = "low" | "medium" | "high";

/**
 * What is allowed to cut the agent off mid-sentence.
 *
 * ⚠️ Barge-in was ON in every mode and it is the single most damaging thing this
 * feature did. Armand, talking while emptying a dishwasher: the agent stopped
 * every ten seconds on `server_vad`, and switching to `semantic_vad` made it
 * WORSE — it cut out mid-sentence roughly every thirty, with no relation to how
 * loud the room was.
 *
 * That pattern points away from the room and at the agent itself: its own voice
 * comes out of the speakers and back into the open microphone. Acoustic echo
 * cancellation is on, but it is imperfect on laptop speakers — and where an
 * amplitude gate at 0.90 might reject a quiet echo, a SEMANTIC detector hears
 * words, which is exactly what an echo of speech contains. Asking "did someone
 * finish a sentence" of the agent's own sentence gets a yes.
 *
 * Whatever the source, the user's own verdict settles the default: an agent that
 * never stops beats one that stops constantly, because a long answer you have to
 * sit through costs seconds while an interruption costs the whole exchange. So
 * "never" is the default, and interrupting is something you turn ON.
 */
export type VadInterrupt = "never" | "speech" | "wake";

export const VAD_INTERRUPT_DEFAULT: VadInterrupt = "never";

export const VAD_MODE_DEFAULT: VadMode = "semantic";
/** Default for the semantic mode: wait, rather than cut in. The complaint that
 *  drove this change was interruption, never sluggishness. */
export const VAD_EAGERNESS_DEFAULT: VadEagerness = "low";

/** The band the loudness threshold is clamped to, and the range its Settings
 *  slider spans. Extremes are useless: ~0 fires on any hiss, ~1 never triggers. */
export const VAD_THRESHOLD_MIN = 0.3;
export const VAD_THRESHOLD_MAX = 0.9;
/** Default amplitude gate — a notch LESS sensitive than OpenAI's 0.5 default. */
export const VAD_THRESHOLD_DEFAULT = 0.6;

const EAGERNESS_VALUES: readonly VadEagerness[] = ["low", "medium", "high"];
const INTERRUPT_VALUES: readonly VadInterrupt[] = ["never", "speech", "wake"];

/** Clamp a threshold to the usable band, falling back to the default on NaN. */
export function clampVadThreshold(v: number): number {
  if (!Number.isFinite(v)) return VAD_THRESHOLD_DEFAULT;
  const rounded = Math.round(v * 100) / 100;
  return Math.min(VAD_THRESHOLD_MAX, Math.max(VAD_THRESHOLD_MIN, rounded));
}

/** Coerce a stored value to a known mode (an older store, or a hand edit). */
export function asVadMode(value: unknown): VadMode {
  return value === "loudness" || value === "semantic" ? value : VAD_MODE_DEFAULT;
}

export function asVadEagerness(value: unknown): VadEagerness {
  return EAGERNESS_VALUES.includes(value as VadEagerness)
    ? (value as VadEagerness)
    : VAD_EAGERNESS_DEFAULT;
}

export function asVadInterrupt(value: unknown): VadInterrupt {
  return INTERRUPT_VALUES.includes(value as VadInterrupt)
    ? (value as VadInterrupt)
    : VAD_INTERRUPT_DEFAULT;
}

export interface VadSettings {
  mode: VadMode;
  eagerness: VadEagerness;
  threshold: number;
  interrupt: VadInterrupt;
}

/**
 * Build the `turn_detection` block for a Realtime `session.update`.
 *
 * It travels at `session.audio.input.turn_detection` — see realtime.ts.
 *
 * `interrupt_response` is only handed to the server for the "speech" mode. The
 * "wake" mode interrupts too, but on OUR terms: the wake detector is a far
 * stricter judge than any turn detector (a specific phrase, two consecutive
 * steps over 0.90, vetoed unless Silero agrees it was speech), so the app sends
 * the cancel itself rather than letting the server decide — see realtime.ts.
 *
 * `create_response` stays on in every mode: a turn you took while the agent was
 * talking is still answered, just after it finishes rather than over the top.
 */
export function buildTurnDetection(settings: VadSettings): Record<string, unknown> {
  const interruptOnSpeech = asVadInterrupt(settings.interrupt) === "speech";
  if (asVadMode(settings.mode) === "loudness") {
    return {
      type: "server_vad",
      threshold: clampVadThreshold(settings.threshold),
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      interrupt_response: interruptOnSpeech,
      create_response: true,
    };
  }
  return {
    type: "semantic_vad",
    eagerness: asVadEagerness(settings.eagerness),
    interrupt_response: interruptOnSpeech,
    create_response: true,
  };
}
