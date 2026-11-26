// The activity orb's geometry: the per-state tuning over the thinking-orbs presets, and the
// "pinch" transition between two shapes (breathe in, contract while spinning up, swap the
// shape at the smallest point behind a flash, spring back out with a ~7 % overshoot, one full
// turn). Pure math over (state, size, time) — no canvas, no clock, no React — so it is tested
// numerically. Ported from the reference validated with Alexandre on 2026-11-26 (demo
// `orbes-flight-deck.html`, section "Transition"); keep the constants as they are.
import { MODE_FRAMES, finalizeFrame, resolvePreset, scaleRadii } from "thinking-orbs";
import type { Dot, ModeFrame, ModeOpts, OrbFrame, OrbSize, OrbState } from "thinking-orbs";

// ---------------------------------------------------------------------------
// 1. Per-state tuning on top of the library presets
// ---------------------------------------------------------------------------

/** Speed / dot-size retouches per state. `working` = the "Thinking…" state; `shaping` (Edit /
 *  Write) runs faster so its shape change actually reads at 16-20 px. */
export const TUNE: Partial<Record<OrbState, { speed?: number; dotSize?: number }>> = {
  working: { speed: 1.35, dotSize: 1.3 },
  shaping: { speed: 1.6 },
};

interface Tuned {
  fn: ModeFrame;
  opts: ModeOpts;
  speed: number;
}
const tunedCache = new Map<string, Tuned>();

function tuned(state: OrbState, size: OrbSize): Tuned {
  const key = `${state}@${size}`;
  let r = tunedCache.get(key);
  if (!r) {
    const p = resolvePreset(state, size);
    const tu = TUNE[state] ?? {};
    const opts = tu.dotSize ? scaleRadii(p.opts, tu.dotSize) : p.opts;
    r = { fn: MODE_FRAMES[p.mode], opts, speed: p.speed * (tu.speed ?? 1) };
    tunedCache.set(key, r);
  }
  return r;
}

/** One state's frame at `t` — seconds of the SHARED clock, before the state's own speed. */
export function liveFrame(state: OrbState, size: OrbSize, t: number): OrbFrame {
  const r = tuned(state, size);
  return r.fn(size, t * r.speed, r.opts);
}

// ---------------------------------------------------------------------------
// 2. The "pinch" transition curves
// ---------------------------------------------------------------------------

/** When (0..1 of the transition) the shape swaps — at the smallest point. The text beside the
 *  orb changes at this exact instant too, not when the transition starts. */
export const SWAP = 0.42;
/** The smallest scale the orb contracts to. */
export const S_MIN = 0.12;
/** ONE FULL TURN: at the end the rotation is the identity. Any total that is not a multiple of
 *  2π makes the orb visibly snap back on the last frame (seen in the demo's v4, fixed in v5). */
export const TURN = Math.PI * 2;
/** Validated feel: 0.85 s total, spring damping ζ 0.62 (≈ 7 % overshoot), swell k 1.2 (+4.7 %). */
export const FEEL = { duration: 0.85, zeta: 0.62, swell: 1.2 } as const;
export type Feel = { duration: number; zeta: number; swell: number };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const u = clamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
/** "back-in": a slight swell (the breath in) then an accelerating fall. k 1.2 → +4.7 %. */
const backIn = (q: number, k: number) => q * q * ((k + 1) * q - k);

/** Damped spring response normalised on [0,1], landing exactly on 1 at the end. */
function spring(q: number, zeta: number): number {
  const w = 5.2 / zeta;
  let y: number;
  if (zeta >= 0.999) y = 1 - Math.exp(-w * q) * (1 + w * q);
  else {
    const wd = w * Math.sqrt(1 - zeta * zeta);
    y = 1 - Math.exp(-zeta * w * q) * (Math.cos(wd * q) + ((zeta * w) / wd) * Math.sin(wd * q));
  }
  return y + (1 - y) * smooth(0.8, 1, q);
}

/** The orb's scale at progress `p` (0..1): 1 → swell → S_MIN at SWAP → overshoot → 1. */
export function pinchScale(p: number, feel: Feel = FEEL): number {
  if (p < SWAP) return 1 - (1 - S_MIN) * backIn(p / SWAP, feel.swell);
  return S_MIN + (1 - S_MIN) * spring((p - SWAP) / (1 - SWAP), feel.zeta);
}

// Rotation: a bell-shaped angular speed peaking at the swap, the momentum then running out.
const RA = (2.6 * SWAP) / (1 - SWAP);
/** The orb's rotation (radians) at progress `p`: 0 → TURN/2 at SWAP → TURN. */
export function pinchTurn(p: number): number {
  return (
    TURN *
    (p < SWAP ? 0.5 * Math.pow(p / SWAP, RA) : 0.5 + 0.5 * (1 - Math.pow(1 - (p - SWAP) / (1 - SWAP), 2.6)))
  );
}

/** Scale + rotate a frame about its centre, fade it by `k`, and optionally add the flash. */
function transform(F: OrbFrame, s: number, th: number, k: number, size: number, extra: Dot | null): OrbFrame {
  const c = size / 2;
  const sn = Math.sin(th);
  const cs = Math.cos(th);
  const R = (x: number, y: number): [number, number] => {
    const dx = (x - c) * s;
    const dy = (y - c) * s;
    return [c + dx * cs - dy * sn, c + dx * sn + dy * cs];
  };
  const rk = s < 1 ? 0.5 + 0.5 * s : 1 + (s - 1) * 0.7; // dots shrink slower than the orb
  const dots: Dot[] = F.dots.map((d) => {
    const [x, y] = R(d.x, d.y);
    return { ...d, x, y, r: d.r * rk, a: (d.a ?? 1) * k };
  });
  const lines = F.lines.map((l) => {
    const [x1, y1] = R(l.x1, l.y1);
    const [x2, y2] = R(l.x2, l.y2);
    return { ...l, x1, y1, x2, y2, a: (l.a ?? 1) * k };
  });
  if (extra) dots.push(extra);
  return finalizeFrame(dots, lines, 0.3);
}

/** A transition in flight (or done): `from` → `to`, started at `start` (shared-clock seconds).
 *  `from === null` means no transition — the orb simply shows `to`. */
export interface Morph {
  from: OrbState | null;
  to: OrbState;
  start: number;
  feel: Feel;
}

/** Transition progress (0..1) at `t`; 1 when there is no transition. */
export function morphProgress(m: Morph, t: number): number {
  if (!m.from || m.feel.duration <= 0) return 1;
  return clamp01((t - m.start) / m.feel.duration);
}

/** The frame to paint at `t` (shared-clock seconds) for a possibly-transitioning orb. */
export function morphFrame(m: Morph, size: OrbSize, t: number): OrbFrame {
  const p = morphProgress(m, t);
  if (!m.from || p >= 1) return liveFrame(m.to, size, t);
  const s = pinchScale(p, m.feel);
  const th = pinchTurn(p);
  // The flash at the centre, at the swap.
  const bell = Math.exp(-Math.pow((p - SWAP) / 0.075, 2));
  const bead: Dot | null =
    bell > 0.02
      ? { x: size / 2, y: size / 2, z: 9, r: (size > 40 ? 3.4 : 1.7) * (0.6 + 0.4 * bell), white: 0.02, a: bell }
      : null;
  if (p < SWAP) {
    const q = p / SWAP;
    // The inside races ahead as it contracts (a growing time advance).
    return transform(liveFrame(m.from, size, t + 0.32 * q * q * q), s, th, 1 - 0.3 * q * q, size, bead);
  }
  const q = (p - SWAP) / (1 - SWAP);
  return transform(liveFrame(m.to, size, t), s, th, 0.7 + 0.3 * smooth(0, 0.45, q), size, bead);
}
