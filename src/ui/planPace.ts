// Weekly delta: how far a weekly window's real usage sits from the straight line that would land
// on exactly 100 % at its reset — « am I burning my week faster than the week passes? ».
//
// Since Anthropic retired the 5-hour window on Ultra accounts (VERIFIED live 2026-11-02:
// `five_hour: null`, no `session` entry in `limits[]`), the weekly window is the only account-wide
// cap left there, and a bare « 34 % » no longer says whether that is a lot: on day 2 it is a lot,
// on day 6 it is very little. The delta answers that with ONE number — the gap, in percentage
// points, between the usage and the share of the week already elapsed. Shown « Δ +12 pts ».
//
// Graded by its SIGN only (decision of Alexandre, 2026-11-02): Δ < 0 is good (green — below the
// line, budget to spare), Δ > 0 is bad (red), Δ 0 neutral. No tolerance band around zero.
//
// ⚠️ A positive delta means EXACTLY « at the average rate so far, the window fills before it
// resets »: used > 100·elapsed/window  ⇔  used / (elapsed/window) > 100. So red is not a style
// judgement, it is that projection — and the « full in … » line only restates it in time.
//
// Pure — no React, no store, no clock of its own (`nowSec` is a parameter) — so every boundary
// (window not started, past its reset, the first hours, the sign) is pinned by tests.

import type { PlanUsageWindow } from "./kit";
import { fmtReset, resetToEpochSeconds } from "./planUsageFormat";

/** A weekly window's length. The endpoint gives only the reset, never the start: the start is
 *  the reset minus this. */
export const WEEK_SECONDS = 7 * 86_400;

/** The « full in … » projection waits for this much of the week to have passed: one busy first
 *  hour extrapolated over seven days says nothing true. The delta itself is shown from the start —
 *  in points it stays small early, which is honest. */
export const PROJECTION_MIN_ELAPSED = 12 * 3600;

/** The delta's sign: `over` = Δ > 0 (red), `under` = Δ < 0 (green), `on` = Δ 0 (neutral). */
export type PaceVerdict = "under" | "on" | "over";

export interface PlanPace {
  /** The share of the window already elapsed, 0–100 — where a perfectly even spend would be now.
   *  Not rounded: it positions the marker on the bar. */
  expected: number;
  /** The usage, clamped 0–100, not rounded. */
  used: number;
  /** `used − expected`, rounded to whole points — the figure shown. */
  delta: number;
  /** The sign of the ROUNDED delta, so « Δ 0 » can never be drawn red or green. */
  verdict: PaceVerdict;
  /** Δ > 0 only: when the window fills at the average rate so far (epoch SECONDS), strictly
   *  before its reset. `null` when Δ ≤ 0, already full, or too early to project. */
  fullAtSec: number | null;
  /** The window's reset (epoch seconds). */
  resetSec: number;
}

/**
 * The delta of a window that spans `windowSeconds` (a week by default), at `nowSec`.
 *
 * `null` — no delta is shown, never a made-up one — when the reset is unknown (a scoped cap that has
 * never started reports none), already passed (the figure belongs to a window that is over), or so
 * far ahead that the window has not started yet (no elapsed share to compare against).
 */
export function windowPace(
  w: PlanUsageWindow,
  nowSec: number,
  windowSeconds: number = WEEK_SECONDS,
): PlanPace | null {
  const resetSec = resetToEpochSeconds(w.resets_at);
  if (resetSec === null || resetSec <= nowSec) return null;
  const elapsed = windowSeconds - (resetSec - nowSec);
  if (elapsed <= 0) return null;
  const expected = (elapsed / windowSeconds) * 100;
  const used = Math.min(100, Math.max(0, w.used_percentage));
  // `|| 0` folds a rounded -0 into 0, so it labels « Δ 0 », never « Δ −0 ».
  const delta = Math.round(used - expected) || 0;
  const verdict: PaceVerdict = delta > 0 ? "over" : delta < 0 ? "under" : "on";
  let fullAtSec: number | null = null;
  if (verdict === "over" && used < 100 && elapsed >= PROJECTION_MIN_ELAPSED) {
    // used > 0 is implied by Δ > 0 (expected > 0), so the rate is never zero.
    const ratePerSec = used / elapsed;
    const at = nowSec + Math.ceil((100 - used) / ratePerSec);
    fullAtSec = at < resetSec ? at : null;
  }
  return { expected, used, delta, verdict, fullAtSec, resetSec };
}

/** The signed figure: « +12 », « −8 », « 0 » (a real minus sign, not a hyphen). */
export function paceFigure(p: PlanPace): string {
  if (p.delta > 0) return `+${p.delta}`;
  if (p.delta < 0) return `−${-p.delta}`;
  return "0";
}

/** « Δ +12 pts » / « Δ −8 pts » / « Δ 0 ». */
export function paceLabel(p: PlanPace): string {
  return p.delta === 0 ? "Δ 0" : `Δ ${paceFigure(p)} pts`;
}

/** What follows the label, when there is something worth saying: « full in 2d 4h » once Δ > 0
 *  and projectable. `null` otherwise. */
export function paceDetail(p: PlanPace, nowSec: number): string | null {
  return p.fullAtSec === null ? null : `full ${fmtReset(p.fullAtSec, nowSec)}`;
}

/** The explanation behind the figure, for a tooltip — the numbers the delta is made of. */
export function paceExplain(p: PlanPace, nowSec: number): string {
  const elapsed = Math.round(p.expected);
  const used = Math.round(p.used);
  const head = `${elapsed}% of the week has passed, ${used}% of it is used.`;
  if (p.verdict === "over") {
    return p.fullAtSec !== null
      ? `${head} At this rate the window fills ${fmtReset(p.fullAtSec, nowSec)} — before it resets ${fmtReset(p.resetSec, nowSec)}.`
      : `${head} Spending faster than the week passes.`;
  }
  if (p.verdict === "under") {
    return `${head} ${-p.delta} pts below an even spend — budget to spare.`;
  }
  return `${head} Exactly on an even spend.`;
}
