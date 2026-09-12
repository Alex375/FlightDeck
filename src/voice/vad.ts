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

export interface VadSettings {
  mode: VadMode;
  eagerness: VadEagerness;
  threshold: number;
}

/**
 * Build the `turn_detection` block for a Realtime `session.update`.
 *
 * It travels at `session.audio.input.turn_detection` — see realtime.ts.
 *
 * Barge-in stays ON in both modes: cutting the agent off by speaking is wanted
 * behaviour. What changed is WHAT counts as speaking.
 */
export function buildTurnDetection(settings: VadSettings): Record<string, unknown> {
  if (asVadMode(settings.mode) === "loudness") {
    return {
      type: "server_vad",
      threshold: clampVadThreshold(settings.threshold),
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      interrupt_response: true,
      create_response: true,
    };
  }
  return {
    type: "semantic_vad",
    eagerness: asVadEagerness(settings.eagerness),
    interrupt_response: true,
    create_response: true,
  };
}
