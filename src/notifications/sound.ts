// Flight Deck's own notification sounds, synthesized with the Web Audio API — no
// bundled asset, no network, no decode. Each sound is a short motif of notes, each
// note a few sine partials (gentle or struck attack, exponential decay) sent through
// a lowpass filter. The catalogue is {@link COMPOSED_SOUNDS}; the factory pair is
// "Soft rise" (a turn finished) and "Soft fall" (input needed). The user picks one
// sound per event in Settings → Notifications — that choice, and the macOS sound
// FILES offered next to these, are routed by notificationSound.ts.
//
// Kept deliberately tiny and self-contained; this fits the project's "fast and
// very optimized" principle better than shipping and decoding audio files.
//
// ── Reliability: a FRESH AudioContext per play ──────────────────────────────
// WKWebView (Tauri's macOS webview) shares the system audio unit. When another
// app or an HTML5 <video> grabs and reconfigures audio — the user "launches a
// video on the side" — a LONG-LIVED AudioContext can become permanently silent:
// its `state` keeps reading "running" while nothing reaches the speakers, and
// resume() does NOT revive it. There is no JS signal for "running but silent",
// so a stale context can't be detected and repaired in place. The robust fix is
// to never keep one around: every chime builds a NEW AudioContext (binding to
// whatever audio configuration is current), plays, then close()s it to release
// the audio unit. This is what makes the chime — and the Settings "Tester"
// button — work every time, even after other audio has played.

function contextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

// Contexts we've opened and not yet closed, each tagged with the wall-clock time
// (performance.now()) its chime is expected to have fully decayed. Each play
// self-closes after its chime decays, but we also cap the set: a burst of plays
// must never exhaust WKWebView's per-document AudioContext limit (~4–6), after
// which construction throws. When at the cap we evict the context CLOSEST TO DONE
// (smallest endsAt) — an already-silent or nearly-decayed one — so a chime that is
// still audibly ringing is never cut off (a fleet burst of ≥5 near-simultaneous
// completions used to truncate the oldest-OPENED one, which may still be sounding).
type LiveContext = { ac: AudioContext; endsAt: number };
const live: LiveContext[] = [];
const MAX_LIVE = 4;

function closeContext(ac: AudioContext): void {
  const i = live.findIndex((l) => l.ac === ac);
  if (i !== -1) live.splice(i, 1);
  try {
    if (ac.state === "closed") return;
    // Spec: close() returns a Promise. Older WebKit returns undefined. Handle
    // both, and swallow any rejection so a failed close never bubbles up.
    const r = ac.close() as Promise<void> | undefined;
    if (r && typeof r.then === "function") r.catch(() => {});
  } catch {
    /* already closing/closed, or a fake context in tests — nothing to free */
  }
}

/** Evict the live context closest to finishing, so a still-ringing chime is never cut. */
function evictClosestToDone(): void {
  let idx = 0;
  for (let i = 1; i < live.length; i++) {
    if (live[i].endsAt < live[idx].endsAt) idx = i;
  }
  closeContext(live[idx].ac);
}

/** Build a fresh AudioContext, evicting the one closest to done if we've hit the cap. */
function newContext(): AudioContext | null {
  const Ctor = contextCtor();
  if (!Ctor) return null;
  while (live.length >= MAX_LIVE) evictClosestToDone();
  let ac: AudioContext;
  try {
    ac = new Ctor();
  } catch {
    return null; // construction can throw if the limit is somehow still hit
  }
  // endsAt is set once scheduleChime knows the decay time; until then treat it as
  // far-off so a not-yet-playing context isn't evicted ahead of a decaying one.
  live.push({ ac, endsAt: Number.POSITIVE_INFINITY });
  return ac;
}

/** The timbre of a note: its sine partials as [frequency multiple, relative gain], and
 *  how fast it swells in (seconds — ~0.04 is a soft bell, a few ms is struck/plucked). */
interface Voice {
  partials: ReadonlyArray<readonly [mult: number, gain: number]>;
  attack: number;
}

/** Round, woody bell — near-harmonic partials kept quiet (the factory chimes). */
const BELL: Voice = { partials: [[1, 1], [2, 0.18], [3, 0.05]], attack: 0.04 };
/** A struck chime: brighter partials, a quick attack (the cabin / seatbelt dings). */
const DING: Voice = { partials: [[1, 1], [2, 0.32], [3, 0.1], [4.2, 0.04]], attack: 0.012 };
/** A marimba bar: the fundamental plus its characteristic ~4× and ~9× modes. */
const MARIMBA: Voice = { partials: [[1, 1], [3.9, 0.28], [9.2, 0.05]], attack: 0.004 };
/** Glass: inharmonic partials, the shimmer of a struck crystal. */
const GLASS: Voice = { partials: [[1, 1], [2.76, 0.32], [5.4, 0.12], [8.93, 0.04]], attack: 0.006 };
/** A bare sine. */
const PURE: Voice = { partials: [[1, 1]], attack: 0.006 };

/**
 * One note of `voice` at `freq`, starting at `start`s for `dur`s. `glideTo` sweeps the
 * pitch to that frequency over the first `glideTime`s (a bubble's "bloop").
 */
function note(
  ac: AudioContext,
  out: AudioNode,
  voice: Voice,
  freq: number,
  start: number,
  dur: number,
  gain: number,
  glide?: { to: number; time: number },
): void {
  for (const [mult, g] of voice.partials) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    if (glide) {
      osc.frequency.setValueAtTime(freq * mult, start);
      osc.frequency.exponentialRampToValueAtTime(glide.to * mult, start + glide.time);
    } else {
      osc.frequency.value = freq * mult;
    }
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(gain * g, start + voice.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur); // soft exponential decay
    osc.connect(env);
    env.connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }
}

/** A Flight Deck sound: a short motif laid down by `play`. */
export interface ComposedSound {
  /** Stored in the prefs; the `flightdeck:` prefix tells it apart from a macOS sound file. */
  id: string;
  label: string;
  /** Lowpass cutoff on the master (Hz) — lower is warmer. */
  cutoff: number;
  /** Loudness trim, so every sound sits near the factory chimes' level (1 = theirs). Set from
   *  the loudest 300 ms RMS of an offline render, nudged down for the brighter sounds the ear
   *  hears as louder and up for the shortest ones. */
  level: number;
  /** Lay the notes down from `t` (context time); returns when the last one has decayed. */
  play: (ac: AudioContext, out: AudioNode, t: number) => number;
}

// Note frequencies (Hz), equal temperament.
const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880.0;
const B5 = 987.77;
const C6 = 1046.5;
const D6 = 1174.66;
const E6 = 1318.51;
const B6 = 1975.53;

/** Every Flight Deck sound, in picker order. */
export const COMPOSED_SOUNDS: readonly ComposedSound[] = [
  {
    // C5 → G5: a low, warm, resolved ascending fifth — slow and unhurried.
    id: "flightdeck:rise",
    label: "Soft rise",
    cutoff: 1500,
    level: 1,
    play: (ac, out, t) => {
      note(ac, out, BELL, C5, t, 1.0, 0.26);
      note(ac, out, BELL, G5, t + 0.18, 1.2, 0.24);
      return t + 0.18 + 1.2;
    },
  },
  {
    // A5 → E5: a soft descending two-note, still noticeable but mellow.
    id: "flightdeck:fall",
    label: "Soft fall",
    cutoff: 1500,
    level: 1,
    play: (ac, out, t) => {
      note(ac, out, BELL, A5, t, 0.85, 0.26);
      note(ac, out, BELL, E5, t + 0.18, 1.15, 0.24);
      return t + 0.18 + 1.15;
    },
  },
  {
    // The airliner PA "ding-dong": a high-low pair, unhurried, left to ring.
    id: "flightdeck:cabin",
    label: "Cabin chime",
    cutoff: 2600,
    level: 1.05,
    play: (ac, out, t) => {
      note(ac, out, DING, B5, t, 1.6, 0.26);
      note(ac, out, DING, G5, t + 0.42, 1.9, 0.26);
      return t + 0.42 + 1.9;
    },
  },
  {
    // The single bright "bong" of the seatbelt sign.
    id: "flightdeck:seatbelt",
    label: "Seatbelt sign",
    cutoff: 3000,
    level: 1.05,
    play: (ac, out, t) => {
      note(ac, out, DING, D6, t, 1.5, 0.26);
      return t + 1.5;
    },
  },
  {
    // A quick major arpeggio up to the octave — something landed.
    id: "flightdeck:arrival",
    label: "Arrival",
    cutoff: 2200,
    level: 1,
    play: (ac, out, t) => {
      note(ac, out, BELL, C5, t, 0.9, 0.2);
      note(ac, out, BELL, E5, t + 0.09, 0.9, 0.2);
      note(ac, out, BELL, G5, t + 0.18, 1.0, 0.21);
      note(ac, out, BELL, C6, t + 0.27, 1.3, 0.22);
      return t + 0.27 + 1.3;
    },
  },
  {
    // A short-long pair rising a sixth, like a voice lifting at the end of a question.
    id: "flightdeck:query",
    label: "Query",
    cutoff: 2000,
    level: 1.1,
    play: (ac, out, t) => {
      note(ac, out, BELL, E5, t, 0.5, 0.24);
      note(ac, out, BELL, C6, t + 0.16, 1.0, 0.25);
      return t + 0.16 + 1.0;
    },
  },
  {
    // A sonar ping and two fading echoes.
    id: "flightdeck:radar",
    label: "Radar ping",
    cutoff: 4000,
    level: 1.3,
    play: (ac, out, t) => {
      note(ac, out, PURE, E6, t, 1.1, 0.26);
      note(ac, out, PURE, E6, t + 0.32, 0.9, 0.09);
      note(ac, out, PURE, E6, t + 0.64, 0.8, 0.03);
      return t + 0.64 + 0.8;
    },
  },
  {
    // Two woody marimba notes, a fifth apart.
    id: "flightdeck:marimba",
    label: "Marimba",
    cutoff: 3800,
    level: 1.1,
    play: (ac, out, t) => {
      note(ac, out, MARIMBA, D5, t, 0.55, 0.3);
      note(ac, out, MARIMBA, A5, t + 0.13, 0.7, 0.3);
      return t + 0.13 + 0.7;
    },
  },
  {
    // Two rising "bloops".
    id: "flightdeck:bubble",
    label: "Bubble",
    cutoff: 5000,
    level: 1.6,
    play: (ac, out, t) => {
      note(ac, out, PURE, 420, t, 0.22, 0.3, { to: 1050, time: 0.07 });
      note(ac, out, PURE, 560, t + 0.13, 0.26, 0.3, { to: 1400, time: 0.07 });
      return t + 0.13 + 0.26;
    },
  },
  {
    // A struck crystal, with a faint shimmer a fifth above.
    id: "flightdeck:crystal",
    label: "Crystal",
    cutoff: 7000,
    level: 1.2,
    play: (ac, out, t) => {
      note(ac, out, GLASS, E6, t, 1.4, 0.2);
      note(ac, out, GLASS, B6, t + 0.1, 1.2, 0.08);
      return t + 0.1 + 1.2;
    },
  },
  {
    // Three quick, soft taps on one note — insistent without being harsh.
    id: "flightdeck:taps",
    label: "Three taps",
    cutoff: 2400,
    level: 1.35,
    play: (ac, out, t) => {
      note(ac, out, DING, A5, t, 0.4, 0.24);
      note(ac, out, DING, A5, t + 0.14, 0.4, 0.22);
      note(ac, out, DING, A5, t + 0.28, 0.4, 0.24);
      return t + 0.28 + 0.4;
    },
  },
];

/** The Flight Deck sound with this id, or undefined. */
export function composedSound(id: string): ComposedSound | undefined {
  return COMPOSED_SOUNDS.find((s) => s.id === id);
}

// Whether the first-gesture warm-up listener has been installed (idempotent).
let primed = false;

/**
 * Warm up audio permission on the first user gesture. WebKit forbids audio until
 * the document has seen a gesture; a chime fired while the app is in the
 * background (an agent finishing unfocused) has no gesture of its own. So on the
 * first click/keypress we build a throwaway context, resume it (which flips the
 * document to "audio allowed" for the rest of its life), then close it — the
 * per-play contexts created later are then free to run without a gesture.
 * Idempotent; safe to call from a React effect that may run twice.
 */
export function primeAudioUnlock(): void {
  if (primed || typeof window === "undefined") return;
  primed = true;
  const warm = () => {
    window.removeEventListener("pointerdown", warm);
    window.removeEventListener("keydown", warm);
    const ac = newContext();
    if (!ac) return;
    // Resume within the gesture to satisfy the autoplay policy, then release the
    // unit — the "audio allowed" grant survives the close().
    Promise.resolve(ac.state === "running" ? undefined : ac.resume())
      .catch(() => {})
      .finally(() => closeContext(ac));
  };
  window.addEventListener("pointerdown", warm);
  window.addEventListener("keydown", warm);
}

/** The two notification events, each with its own user-chosen sound. */
export type ChimeKind = "done" | "attention";

/**
 * Play the Flight Deck sound `id` at `volume` (1 = its normal level). Returns false
 * for an unknown id (nothing played) — the caller picks a fallback. A no-op that
 * still returns true when Web Audio is unavailable: the sound exists, this webview
 * just can't make it.
 *
 * A fresh AudioContext is built for every call (see the file header) so a stale,
 * silently-broken context from an earlier audio-session change can never carry
 * over. WKWebView can hand back that fresh context `suspended` (before any
 * gesture) or `interrupted` (iOS/Safari), and `resume()` is ASYNC — scheduling
 * oscillators on a context whose clock isn't advancing silently drops the sound.
 * So we resume FIRST and lay the notes down only once the context is running.
 */
export function playComposed(id: string, volume = 1): boolean {
  const sound = composedSound(id);
  if (!sound) return false;
  const ac = newContext();
  if (!ac) return true;
  if (ac.state === "running") {
    // Guard symmetrically with the suspended branch below: if node construction
    // throws on a context that reads "running" but whose audio unit was just
    // reconfigured, free it rather than leak it + throw out of playComposed.
    try {
      scheduleChime(ac, sound, volume);
    } catch {
      closeContext(ac);
    }
    return true;
  }
  // Suspended or "interrupted": wait for the resume to land, then schedule on the
  // now-advancing clock. If resume rejects (e.g. no user gesture yet) we still
  // attempt to schedule — worst case a no-op, never a throw.
  ac.resume()
    .then(() => scheduleChime(ac, sound, volume))
    .catch((e) => {
      // resume() rejected (e.g. no user gesture yet) OR scheduling threw because the
      // context became unusable. Retry best-effort, then swallow: a dropped chime
      // must NEVER surface as an unhandled promise rejection (this runs in a
      // microtask, past the caller's guard). Close the dead context either way.
      console.error("audio chime failed:", e);
      try {
        scheduleChime(ac, sound, volume);
      } catch {
        closeContext(ac); // context unusable — free it and give up silently
      }
    });
  return true;
}

/** The master level of every Flight Deck sound at volume 1 — soft by design. */
const MASTER_LEVEL = 0.26;

/** Lay down `sound` at `volume`, then close the context once it decays. */
function scheduleChime(ac: AudioContext, sound: ComposedSound, volume: number): void {
  // Soft master level + a lowpass filter that rolls off the highs, so the sound
  // is warm and gentle rather than sharp.
  const master = ac.createGain();
  master.gain.value = MASTER_LEVEL * sound.level * Math.max(0, volume);
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = sound.cutoff;
  lp.Q.value = 0.5;
  master.connect(lp);
  lp.connect(ac.destination);

  const end = sound.play(ac, master, ac.currentTime + 0.02);

  // Once the sound has fully decayed, close the whole context — this is the
  // single-use lifecycle that keeps every play on a fresh audio unit. Closing
  // tears down the master + filter + oscillators in one shot, so no dangling
  // node accumulates and the audio unit is handed back to the OS.
  const ms = Math.max(0, (end + 0.15 - ac.currentTime) * 1000);
  // Record when this context goes silent so eviction can prefer the one closest
  // to done (see evictClosestToDone) rather than cutting off a still-ringing chime.
  const entry = live.find((l) => l.ac === ac);
  if (entry) entry.endsAt = performance.now() + ms;
  setTimeout(() => closeContext(ac), ms);
}
