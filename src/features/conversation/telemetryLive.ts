// The LIVE half of the telemetry deck: the per-frame arithmetic behind its millisecond clocks,
// its needles and its oscilloscope. Pure — the deck's frame loop only supplies the clock and
// the store's current values, so every rule here is pinned by tests.
//
// What "live" may and may not do: the deck redraws sixty times a second while the agent works,
// but only ever to show a REAL quantity at its current value — a timer running from a real
// stamp, a needle easing towards a real reading, a trace of a real rate. Smoothing is allowed
// (a needle that eases is still pointing at the truth); invention is not.

/** A duration as the deck's big clocks read it: `0:12.347`, then `1:02:05.123` past an hour. */
export function fmtClockMs(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const msPart = String(safe % 1000).padStart(3, "0");
  const total = Math.floor(safe / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}.${msPart}` : `${m}:${ss}.${msPart}`;
}

/** A short duration, for a single call or a state: `0.142s`, `12.31s`, then `1:02.4`. The
 *  precision drops as the number grows — a minute-long call does not need its milliseconds. */
export function fmtSecs(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 10_000) return `${(safe / 1000).toFixed(3)}s`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(2)}s`;
  const total = safe / 1000;
  const m = Math.floor(total / 60);
  return `${m}:${(total - m * 60).toFixed(1).padStart(4, "0")}`;
}

/**
 * Move `current` towards `target` over one frame of `dtMs`, closing the gap by a time constant
 * of `tauMs` — the same step for a needle's easing and a rate's smoothing, and frame-rate
 * independent (a dropped frame takes a bigger step, not a slower needle).
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (!(dtMs > 0) || !(tauMs > 0)) return target;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return current + (target - current) * k;
}

/**
 * How many characters were STREAMED since the last frame, across every bubble open right now
 * (the main thread's and each sub-agent's).
 *
 * ⚠️ Counted per bubble, against that bubble's own last length — never as the difference of a
 * grand total: bubbles close (their buffer is folded into the final message and the length
 * drops) and new ones open mid-frame, and a total would read those as negative or phantom
 * bursts. A bubble seen for the FIRST time contributes nothing: when the deck opens mid-answer,
 * what was already written is not a burst that just happened.
 */
export function streamGrowth(
  last: ReadonlyMap<string, number>,
  open: ReadonlyArray<readonly [id: string, length: number]>,
): { chars: number; next: Map<string, number> } {
  const next = new Map<string, number>();
  let chars = 0;
  for (const [id, length] of open) {
    const before = last.get(id);
    if (before !== undefined && length > before) chars += length - before;
    next.set(id, length);
  }
  return { chars, next };
}

/** Characters per second → an ESTIMATE of tokens per second (≈ 4 characters a token). Labelled
 *  as an estimate wherever it is shown: the wire carries no token count while text streams. */
export function estTokensPerSec(charsPerSec: number): number {
  return Math.max(0, charsPerSec) / 4;
}

/** How a running call is doing against the usual length of its kind in this conversation. */
export type Latency = "unknown" | "ok" | "slow" | "stalled";

/** Past this multiple of the family's median, a call is "stalled" (and its bar is full). */
export const STALLED_RATIO = 3;

/**
 * A running call against its family's median: under it is ok, up to {@link STALLED_RATIO}× is
 * slow, beyond is stalled — and with no median yet (nothing of that kind finished live) there is
 * no honest verdict. `fill` is the bar: the median sits at a third of it, a stall fills it.
 */
export function latency(
  elapsedMs: number,
  medianMs: number | null,
): { level: Latency; fill: number } {
  if (medianMs === null || !(medianMs > 0)) return { level: "unknown", fill: 0 };
  const ratio = elapsedMs / medianMs;
  const fill = Math.min(1, ratio / STALLED_RATIO);
  if (ratio >= STALLED_RATIO) return { level: "stalled", fill };
  if (ratio > 1) return { level: "slow", fill };
  return { level: "ok", fill };
}

/** The current turn against this conversation's median turn — null (no honest reading) before
 *  a turn has completed, or while no turn runs. */
export function turnLoad(elapsedMs: number | null, medianTurnMs: number | null): number | null {
  if (elapsedMs === null || medianTurnMs === null || !(medianTurnMs > 0)) return null;
  return elapsedMs / medianTurnMs;
}

/** A reading's position on a gauge whose full scale is `max`, clamped to the dial. */
export function gaugeFraction(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** Fixed-size ring of samples for the oscilloscope — pure push, oldest dropped. */
export function pushSample(samples: readonly number[], value: number, size: number): number[] {
  const next = samples.length >= size ? samples.slice(samples.length - size + 1) : [...samples];
  next.push(value);
  return next;
}
