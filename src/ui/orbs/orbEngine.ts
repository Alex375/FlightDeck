// The activity orbs' runtime, outside React (like `termManager`): ONE clock and ONE
// requestAnimationFrame loop for every orb on screen, and one shape CHANNEL per conversation.
//
// Why a channel per conversation, not per orb: the thread, the Flight Deck card and the sidebar
// row of the same agent show the same shape and must morph together — and the words beside the
// orb change at the swap instant (see `useHeldUntilSwap`). A channel owns the transition, the
// minimum time per shape (an agent can switch tools several times a second: only the LAST target
// asked for during the hold is kept) and the "shape now shown" that the labels follow.
//
// Why one loop: an orb is a canvas redrawn every frame, and a busy fleet shows one per card plus
// one per sidebar row. A single loop draws them all from one clock, skips the ones scrolled out
// of view (IntersectionObserver) and stops entirely when the window is hidden or nothing visible
// animates. The swap and the hold run on TIMERS, not on frames, so the labels keep moving even
// while nothing is being drawn.
import { paintFrame } from "thinking-orbs/engine";
import type { OrbSize, OrbState } from "thinking-orbs";
import { FEEL, SWAP, morphFrame, morphProgress, type Morph } from "./orbMotion";

/** Minimum time a shape stays (transition included) before the next one may start. */
export const MIN_HOLD_S = 1.5;
/** Frame pacing — the battery knob. A settled orb is 14-20 px and moves a fraction of a pixel
 *  per frame: ~30 fps reads exactly as smooth there and halves the drawing work. A shape
 *  transition (0.85 s, contraction + spring) is where motion is fast and the eye is on it, so
 *  while any VISIBLE orb transitions everything runs at ~60 fps. (Measured 2026-11-26: drawing
 *  costs 0.01-0.19 ms per orb per frame; at a flat 60 fps 8 cards cost about what the old CSS
 *  spinners did.) Values sit just under 1000/30 and 1000/60 so vsync jitter never skips one. */
const REST_FRAME_MS = 31;
const MORPH_FRAME_MS = 15;
/** A channel nobody shows survives this long, so a quick remount keeps its shape. */
const RELEASE_GRACE_MS = 1000;
/** The still image's instant under "reduce motion" (the demo's). */
const STILL_T = 0.6;

/** The shared clock, in seconds. */
export const orbClock = (): number => performance.now() / 1000;

const reducedQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
const reducedMotion = (): boolean => !!reducedQuery?.matches;

// ---------------------------------------------------------------------------
// Channels: one transition state machine per conversation
// ---------------------------------------------------------------------------

interface Channel {
  morph: Morph;
  /** The shape whose words are shown: flips at the swap instant of a transition. */
  shown: OrbState;
  /** No new transition starts before this (shared-clock seconds). */
  heldUntil: number;
  /** The latest shape asked for during the hold, applied when it ends. */
  pending: OrbState | null;
  swapTimer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  refs: number;
  key: string;
}

const channels = new Map<string, Channel>();
/** Listeners by conversation key — independent of the channel's lifetime, so a label can
 *  subscribe before the orb beside it has created the channel. */
const keyListeners = new Map<string, Set<() => void>>();

function notifyKey(key: string): void {
  const set = keyListeners.get(key);
  if (set) for (const fn of set) fn();
}

function notify(ch: Channel): void {
  invalidateStill();
  wake();
  notifyKey(ch.key);
}

function startMorph(ch: Channel, next: OrbState, now: number): void {
  if (ch.swapTimer) clearTimeout(ch.swapTimer);
  ch.pending = null;
  const still = reducedMotion();
  ch.morph = { from: still ? null : ch.morph.to, to: next, start: now, feel: { ...FEEL, duration: still ? 0 : FEEL.duration } };
  ch.heldUntil = now + MIN_HOLD_S;
  const swapMs = ch.morph.feel.duration * SWAP * 1000;
  if (swapMs <= 0) {
    ch.swapTimer = null;
    ch.shown = next;
    notify(ch);
  } else {
    ch.swapTimer = setTimeout(() => {
      ch.swapTimer = null;
      ch.shown = next;
      notify(ch);
    }, swapMs);
    wake();
  }
}

function onHoldEnd(ch: Channel): void {
  ch.holdTimer = null;
  const next = ch.pending;
  ch.pending = null;
  if (next && next !== ch.morph.to) startMorph(ch, next, orbClock());
}

/** Ask a conversation's orb for a shape. Starts the transition now, or — inside the minimum
 *  time of the current shape — remembers it as the target to move to once that time is up
 *  (a later call replaces it; asking for the current shape again cancels it). */
export function requestOrbState(key: string, next: OrbState): void {
  const ch = channels.get(key);
  if (!ch) return;
  if (next === ch.morph.to) {
    ch.pending = null;
    return;
  }
  const now = orbClock();
  if (now < ch.heldUntil) {
    ch.pending = next;
    if (!ch.holdTimer) ch.holdTimer = setTimeout(() => onHoldEnd(ch), (ch.heldUntil - now) * 1000);
    return;
  }
  startMorph(ch, next, now);
}

/** Take a reference on a conversation's channel (created at `initial`, no transition). Returns
 *  the release. The last release frees it after a short grace. */
export function acquireOrbChannel(key: string, initial: OrbState): () => void {
  let ch = channels.get(key);
  if (!ch) {
    ch = {
      morph: { from: null, to: initial, start: 0, feel: { ...FEEL } },
      shown: initial,
      heldUntil: 0,
      pending: null,
      swapTimer: null,
      holdTimer: null,
      releaseTimer: null,
      refs: 0,
      key,
    };
    channels.set(key, ch);
    notifyKey(key);
  }
  if (ch.releaseTimer) {
    clearTimeout(ch.releaseTimer);
    ch.releaseTimer = null;
  }
  ch.refs++;
  const owned = ch;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owned.refs--;
    if (owned.refs > 0) return;
    owned.releaseTimer = setTimeout(() => {
      if (owned.refs > 0 || channels.get(key) !== owned) return;
      if (owned.swapTimer) clearTimeout(owned.swapTimer);
      if (owned.holdTimer) clearTimeout(owned.holdTimer);
      channels.delete(key);
      notifyKey(key);
    }, RELEASE_GRACE_MS);
  };
}

/** The shape whose words are on screen for `key` (flips at the swap), or null without a channel. */
export function shownOrbState(key: string): OrbState | null {
  return channels.get(key)?.shown ?? null;
}

/** Subscribe to `key`'s shown shape (and to its channel appearing / going away). */
export function subscribeOrbChannel(key: string, fn: () => void): () => void {
  let set = keyListeners.get(key);
  if (!set) {
    set = new Set();
    keyListeners.set(key, set);
  }
  set.add(fn);
  return () => {
    const s = keyListeners.get(key);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) keyListeners.delete(key);
  };
}

// ---------------------------------------------------------------------------
// Views: the canvases, drawn by one loop
// ---------------------------------------------------------------------------

export interface OrbViewConfig {
  /** The conversation channel this orb follows. */
  channel: string;
  /** Preset size the geometry is computed at (thinking-orbs tunes 20 for small spinners). */
  size: OrbSize;
  /** CSS pixels on screen; the canvas is scaled down from `size` (the demo's 18 / 16 px). */
  display: number;
  /** A CSS custom property (`--wf-run`) or `currentColor` (the element's text colour). */
  tone: string;
  /** A still image (the conversation stopped on a state): drawn once, never animated. */
  frozen: boolean;
}

interface View {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cfg: OrbViewConfig;
  tint: { r: number; g: number; b: number } | undefined;
  scale: number;
  visible: boolean;
  /** A still view needs one paint after any change. */
  dirty: boolean;
}

const views = new Set<View>();
const byCanvas = new WeakMap<HTMLCanvasElement, View>();
let io: IntersectionObserver | null = null;
let raf = 0;
let lastFrameMs = 0;

function parseColor(c: string): { r: number; g: number; b: number } | undefined {
  const s = c.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return { r: Math.round(+rgb[1]), g: Math.round(+rgb[2]), b: Math.round(+rgb[3]) };
  return undefined;
}

function resolveTint(canvas: HTMLCanvasElement, tone: string): View["tint"] {
  const cs = getComputedStyle(canvas);
  if (tone === "currentColor") return parseColor(cs.color);
  return parseColor(cs.getPropertyValue(tone));
}

function layout(v: View): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(v.cfg.display * dpr);
  if (v.canvas.width !== px) {
    v.canvas.width = px;
    v.canvas.height = px;
  }
  v.canvas.style.width = `${v.cfg.display}px`;
  v.canvas.style.height = `${v.cfg.display}px`;
  v.scale = (v.cfg.display / v.cfg.size) * dpr;
}

function draw(v: View, t: number): void {
  const ch = channels.get(v.cfg.channel);
  if (!ch) return;
  const { ctx } = v;
  const s = v.cfg.size;
  ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);
  ctx.clearRect(0, 0, s, s);
  const still = v.cfg.frozen || reducedMotion();
  // A still orb shows the shape whose words are on screen, never a frame caught mid-transition.
  const m: Morph = still ? { ...ch.morph, from: null, to: ch.shown } : ch.morph;
  paintFrame(ctx, morphFrame(m, s, still ? STILL_T : t), true, v.tint);
}

function animates(v: View): boolean {
  return v.visible && !v.cfg.frozen && !reducedMotion() && v.canvas.isConnected;
}

function invalidateStill(): void {
  for (const v of views) if (v.cfg.frozen || reducedMotion()) v.dirty = true;
}

/** Whether any visible, animating orb is mid-transition at `t` (→ 60 fps pacing). */
function anyMorphing(t: number): boolean {
  for (const v of views) {
    if (!animates(v)) continue;
    const ch = channels.get(v.cfg.channel);
    if (ch?.morph.from && morphProgress(ch.morph, t) < 1) return true;
  }
  return false;
}

function tick(nowMs: number): void {
  raf = 0;
  if (typeof document !== "undefined" && document.hidden) return; // resumed by visibilitychange
  const t = nowMs / 1000;
  const interval = anyMorphing(t) ? MORPH_FRAME_MS : REST_FRAME_MS;
  const due = nowMs - lastFrameMs >= interval;
  let any = false;
  for (const v of views) {
    if (!v.visible || !v.canvas.isConnected) continue;
    if (animates(v)) {
      any = true;
      if (due) draw(v, t);
    } else if (v.dirty) {
      v.dirty = false;
      draw(v, t);
    }
  }
  if (due) lastFrameMs = nowMs;
  if (!any) return;
  // At rest, sleep until the next frame is due instead of waking on every display refresh
  // just to skip it; during a transition, every frame counts.
  const wait = lastFrameMs + interval - performance.now();
  if (interval === MORPH_FRAME_MS || wait <= 4) raf = requestAnimationFrame(tick);
  else
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      raf = requestAnimationFrame(tick);
    }, wait - 4);
}

let sleepTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a frame now (anything changed: a view, a shape…), cutting a rest-pacing sleep short. */
function wake(): void {
  if (raf || typeof requestAnimationFrame === "undefined") return;
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  raf = requestAnimationFrame(tick);
}

let globalsBound = false;
function bindGlobals(): void {
  if (globalsBound || typeof document === "undefined") return;
  globalsBound = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      invalidateStill();
      wake();
    }
  });
  reducedQuery?.addEventListener?.("change", () => {
    for (const v of views) v.dirty = true;
    wake();
  });
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = byCanvas.get(e.target as HTMLCanvasElement);
        if (!v) continue;
        v.visible = e.isIntersecting;
        if (v.visible) v.dirty = true;
      }
      wake();
    });
  }
}

/** Start drawing an orb into `canvas`. Returns the unregister. */
export function registerOrbView(canvas: HTMLCanvasElement, cfg: OrbViewConfig): () => void {
  bindGlobals();
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  // Visible until the observer says otherwise (its first callback reports the real state).
  const v: View = { canvas, ctx, cfg, tint: resolveTint(canvas, cfg.tone), scale: 1, visible: true, dirty: true };
  layout(v);
  views.add(v);
  byCanvas.set(canvas, v);
  io?.observe(canvas);
  // Paint the first image synchronously: a freshly mounted orb is never a blank square.
  draw(v, orbClock());
  v.dirty = false;
  wake();
  return () => {
    views.delete(v);
    byCanvas.delete(canvas);
    io?.unobserve(canvas);
  };
}

/** Apply a changed config (tone, size, frozen) to a registered orb. */
export function updateOrbView(canvas: HTMLCanvasElement, cfg: OrbViewConfig): void {
  const v = byCanvas.get(canvas);
  if (!v) return;
  const toneChanged = v.cfg.tone !== cfg.tone;
  v.cfg = cfg;
  if (toneChanged) v.tint = resolveTint(canvas, cfg.tone);
  layout(v);
  v.dirty = true;
  wake();
}

/** Re-read every orb's colour (e.g. after a theme token changed). */
export function refreshOrbTints(): void {
  for (const v of views) {
    v.tint = resolveTint(v.canvas, v.cfg.tone);
    v.dirty = true;
  }
  wake();
}

/** Test/diagnostic hook: transition progress of `key` now (1 when settled or unknown). */
export function orbChannelProgress(key: string): number {
  const ch = channels.get(key);
  return ch ? morphProgress(ch.morph, orbClock()) : 1;
}
