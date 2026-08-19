// Server-VAD (voice activity detection) tuning for the Realtime session.
// Pure + tiny so it can be unit-tested without dragging in the WebRTC session
// manager (realtime.ts pulls in the IPC client, stores and DOM).
//
// We now configure turn detection EXPLICITLY instead of inheriting OpenAI's
// defaults. The default threshold was over-sensitive: faint sounds registered
// as speech, so the agent cut in / got interrupted too eagerly. Only the
// amplitude `threshold` is user-tunable (the Settings slider); the rest is
// fixed and sane.

/** The band the threshold is clamped to. Extremes are useless: ~0 fires on any
 *  hiss, ~1 never triggers. */
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
 *  @param threshold amplitude gate 0..1 — higher = LESS sensitive (ignores
 *    quiet sounds / background noise); lower = picks up fainter speech.
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
