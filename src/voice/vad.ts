// Server-VAD (voice activity detection) tuning for the Realtime session.
// Pure + tiny so it can be unit-tested without dragging in the WebRTC session
// manager (realtime.ts pulls in the IPC client, stores and DOM).
//
// We now configure turn detection EXPLICITLY instead of inheriting OpenAI's
// defaults. The default threshold was over-sensitive: faint sounds registered
// as speech, so the agent cut in / got interrupted too eagerly. Only the
// `threshold` is user-tunable (the Settings slider); the rest is fixed and sane.
//
// Turn detection stays OpenAI's job. Gating the audio ourselves before it leaves
// the machine was considered and dropped: it would have put a threshold we can
// explain on a bar the user can read, but at the cost of a second detector to
// keep honest, a delay line so it does not clip the first syllable, and
// hysteresis so it does not chop a sentence in two — a lot of machinery to
// second-guess a detector that is doing the job.

/** The band the threshold is clamped to, and the range the Settings slider
 *  spans. Extremes are useless: ~0 fires on any hiss, ~1 never triggers. */
export const VAD_THRESHOLD_MIN = 0.3;
export const VAD_THRESHOLD_MAX = 0.9;
/** Default amplitude gate — a notch LESS sensitive than OpenAI's 0.5 default,
 *  which was the "cuts in too early" complaint. */
export const VAD_THRESHOLD_DEFAULT = 0.6;

/** Clamp a threshold to the usable band, falling back to the default on NaN. */
export function clampVadThreshold(v: number): number {
  if (!Number.isFinite(v)) return VAD_THRESHOLD_DEFAULT;
  const rounded = Math.round(v * 100) / 100;
  return Math.min(VAD_THRESHOLD_MAX, Math.max(VAD_THRESHOLD_MIN, rounded));
}

/** Build the `turn_detection` block for a Realtime `session.update`.
 *
 *  @param threshold how sure OpenAI's detector must be, 0..1 — higher = LESS
 *    sensitive (ignores background noise and stray sound); lower = picks up more.
 *
 *  ⚠️ This is a CONFIDENCE from their speech detector, not an amplitude, and
 *  nothing local shares its scale. Settings once drew it as a handle on the live
 *  level meter, which could never line up and told users to calibrate it against
 *  a number it has no relationship to — see VadMeter.tsx.
 */
export function buildTurnDetection(threshold: number): Record<string, unknown> {
  return {
    type: "server_vad",
    threshold: clampVadThreshold(threshold),
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    // Barge-in stays ON: the user can always cut the agent off by speaking —
    // a wanted behaviour they asked to keep. Raising the THRESHOLD is what
    // stops stray sound from triggering it, without disabling interruption.
    interrupt_response: true,
    create_response: true,
  };
}
