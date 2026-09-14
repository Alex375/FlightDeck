// The microphone constraints, in ONE place.
//
// Two call sites open the mic for the voice agent: the live session
// (`realtime.ts`) and the Settings level meter (`VadMeter.tsx`). They must open
// it the SAME way, or the meter shows you something other than what the agent
// hears — which makes it worse than no meter at all, because it looks
// authoritative.
//
// ⚠️ These are the browser's defaults, written out rather than inherited from a
// bare `{ audio: true }`. That is deliberate: `autoGainControl` is the one to
// question. Its job is to make loud and quiet input come out at the SAME level —
// in a quiet room it winds gain up until the noise floor reads like speech, and
// winds it back down when you speak. Any threshold applied downstream (OpenAI's
// turn detector included) is therefore working on a signal that has been
// deliberately flattened, which is the leading suspect for "the sensitivity
// slider doesn't seem to do anything". Turning it off is a one-word change here
// and affects both call sites at once — but it is a real trade-off (quiet speech
// gets quieter too), so it wants a measurement, not a guess.
//
// WKWebView may not honour every constraint; `describeMicSettings` reads back
// what the track actually got, so a constraint that was ignored is visible
// instead of assumed.
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

/** Open the microphone the way the voice agent does. */
export function openVoiceMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
}

/** A short, human summary of what the track actually negotiated — for the
 *  Settings meter, so an ignored constraint shows rather than hides. */
export function describeMicSettings(stream: MediaStream): string | null {
  const track = stream.getAudioTracks()[0];
  if (!track || typeof track.getSettings !== "function") return null;
  const s = track.getSettings() as MediaTrackSettings & {
    autoGainControl?: boolean;
    noiseSuppression?: boolean;
    echoCancellation?: boolean;
  };
  const flags = [
    s.autoGainControl === undefined ? null : `auto gain ${s.autoGainControl ? "on" : "off"}`,
    s.noiseSuppression === undefined ? null : `noise suppression ${s.noiseSuppression ? "on" : "off"}`,
    s.echoCancellation === undefined ? null : `echo cancellation ${s.echoCancellation ? "on" : "off"}`,
  ].filter((f): f is string => f !== null);
  return flags.length > 0 ? flags.join(" · ") : null;
}

/** Root-mean-square of a block of samples, in [0, 1]. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Floor of the meter's scale, in dBFS. Below this the bar reads empty. */
export const METER_FLOOR_DB = -60;

/**
 * Map an RMS in [0, 1] to a bar fill in [0, 1] on a **dBFS** scale.
 *
 * The old meter used `rms * 3.2`, which put normal speech (RMS ≈ 0.05) at 16% of
 * the bar — under a threshold handle sitting at 60%, so the level could never
 * reach it. Decibels are the scale ears and audio tools actually use: -60 dBFS
 * empty, 0 dBFS full, which lands room tone around 15% and speech around 55%.
 */
export function levelToBar(value: number): number {
  if (!(value > 0)) return 0;
  const db = 20 * Math.log10(value);
  if (db <= METER_FLOOR_DB) return 0;
  return Math.min(1, db / -METER_FLOOR_DB + 1);
}
