// The live "time since your last message" counter shown on a running conversation's
// sidebar row. Two parts:
//
// - PURE formatting (`fmtLiveElapsed`, `liveElapsedPeriod`), unit-tested: centiseconds
//   under a minute so the number visibly ticks ("7.42s"), then minutes + seconds
//   ("3m 07s"), then hours + minutes ("1h 02m").
// - ONE shared clock (`useLiveElapsed`) instead of an interval per row: it runs at
//   ~25 fps only while at least one visible counter still shows centiseconds, drops to
//   once a second otherwise, stops when nothing is mounted, and skips its ticks while
//   the window is hidden. Each counter is its own tiny leaf, so a tick re-renders a
//   <span>, never the row or the list.

import { useCallback, useSyncExternalStore } from "react";

/** Below this, the counter shows centiseconds and needs the fast clock. */
export const CENTI_LIMIT_MS = 60_000;
/** Fast tick while centiseconds are on screen (~25 fps: smooth enough, cheap enough). */
export const FAST_TICK_MS = 40;
/** Slow tick once the label only changes every second. */
export const SLOW_TICK_MS = 1_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format an elapsed duration for the live counter: `"7.42s"` under a minute (floored to
 * the centisecond, so it never shows `"60.00s"`), `"3m 07s"` under an hour, `"1h 02m"`
 * beyond. Negative input (clock skew) clamps to zero.
 */
export function fmtLiveElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  if (t < CENTI_LIMIT_MS) {
    const cs = Math.floor(t / 10);
    return `${Math.floor(cs / 100)}.${pad2(cs % 100)}s`;
  }
  const s = Math.floor(t / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor(s / 60) % 60)}m`;
}

/**
 * Format a duration that is NOT running any more (a row frozen on how long its turn took).
 * Same as {@link fmtLiveElapsed} past a minute, but whole seconds under it: centiseconds
 * are there to show movement, and a stopped counter has none ("53s", not "53.00s").
 */
export function fmtFrozenElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  // Floored, like the live formatter: rounding would print an impossible "60s".
  if (t < CENTI_LIMIT_MS) return `${Math.floor(t / 1000)}s`;
  return fmtLiveElapsed(t);
}

/** The tick period a counter showing `ms` needs: fast while centiseconds show, slow after. */
export function liveElapsedPeriod(ms: number): number {
  return ms < CENTI_LIMIT_MS ? FAST_TICK_MS : SLOW_TICK_MS;
}

// ---- the shared clock ---------------------------------------------------------------

const listeners = new Map<() => void, boolean>(); // listener → wants the fast tick
let timer: ReturnType<typeof setInterval> | null = null;
let period = 0;
let now = Date.now();

function tick() {
  // A hidden window paints nothing: skip the work, the next visible tick catches up.
  if (typeof document !== "undefined" && document.hidden) return;
  now = Date.now();
  for (const l of listeners.keys()) l();
}

function reschedule() {
  let want = 0;
  if (listeners.size > 0) {
    want = SLOW_TICK_MS;
    for (const fast of listeners.values()) {
      if (fast) {
        want = FAST_TICK_MS;
        break;
      }
    }
  }
  if (want === period) return;
  if (timer) clearInterval(timer);
  timer = want ? setInterval(tick, want) : null;
  period = want;
}

/**
 * The live label for a counter started at `startedAt` (epoch ms), or `null` when there is
 * no start. Subscribes to the shared clock; asks for the fast tick only while the label
 * still shows centiseconds. The SNAPSHOT is the formatted label, not the clock: while one
 * counter keeps the clock fast, a counter past a minute gets the same string back 24 times
 * out of 25 and React skips its re-render — so long runs still cost one render per second.
 */
export function useLiveElapsed(startedAt: number | null): string | null {
  // The clock is idle when nothing is mounted: refresh it so this first frame doesn't
  // render from a minutes-old `now` (a "0.00s" flash before the real value).
  if (timer === null) now = Date.now();
  const fast = startedAt != null && liveElapsedPeriod(Date.now() - startedAt) === FAST_TICK_MS;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (startedAt == null) return () => {};
      listeners.set(onChange, fast);
      reschedule();
      return () => {
        listeners.delete(onChange);
        reschedule();
      };
    },
    [startedAt, fast],
  );
  const label = useCallback(
    () => (startedAt == null ? null : fmtLiveElapsed(now - startedAt)),
    [startedAt],
  );
  return useSyncExternalStore(subscribe, label, label);
}
