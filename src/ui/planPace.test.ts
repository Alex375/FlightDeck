import { describe, expect, it } from "vitest";
import {
  PROJECTION_MIN_ELAPSED,
  WEEK_SECONDS,
  paceDetail,
  paceExplain,
  paceFigure,
  paceLabel,
  windowPace,
} from "./planPace";

const NOW = 1_800_000_000;
const DAY = 86_400;
/** A weekly window `elapsedDays` into its week, at `used` %. */
const win = (used: number, elapsedDays: number) => ({
  used_percentage: used,
  resets_at: String(NOW + WEEK_SECONDS - elapsedDays * DAY),
});

describe("windowPace", () => {
  it("compares the usage with the share of the week elapsed", () => {
    // Half the week gone, 62 % used → 12 points ahead of an even spend.
    const p = windowPace(win(62, 3.5), NOW)!;
    expect(p.expected).toBeCloseTo(50, 6);
    expect(p.delta).toBe(12);
    expect(p.verdict).toBe("over");
  });

  it("goes negative when the week passes faster than it is spent", () => {
    const p = windowPace(win(30, 3.5), NOW)!;
    expect(p.delta).toBe(-20);
    expect(p.verdict).toBe("under");
  });

  it("is graded by the SIGN of the rounded figure — no tolerance band", () => {
    expect(windowPace(win(51, 3.5), NOW)!.verdict).toBe("over");
    expect(windowPace(win(49, 3.5), NOW)!.verdict).toBe("under");
    // ±0.4 rounds to 0: neutral, never drawn red or green with a « Δ 0 » label.
    expect(windowPace(win(50.4, 3.5), NOW)!).toMatchObject({ delta: 0, verdict: "on" });
    // A rounded −0 is folded into 0 (it would otherwise label « Δ −0 »).
    const negZero = windowPace(win(49.6, 3.5), NOW)!;
    expect(Object.is(negZero.delta, 0)).toBe(true);
    expect(negZero.verdict).toBe("on");
    expect(windowPace(win(50.6, 3.5), NOW)!).toMatchObject({ delta: 1, verdict: "over" });
  });

  it("parses an ISO reset as well as epoch-seconds digits", () => {
    const iso = new Date((NOW + 4 * DAY) * 1000).toISOString();
    const p = windowPace({ used_percentage: 10, resets_at: iso }, NOW)!;
    expect(p.expected).toBeCloseTo((3 / 7) * 100, 6);
  });

  it("gives no pace when there is nothing true to compare against", () => {
    // Reset unknown (a scoped cap that has never started).
    expect(windowPace({ used_percentage: 0, resets_at: null }, NOW)).toBeNull();
    // Reset already passed: the figure belongs to a window that is over.
    expect(windowPace({ used_percentage: 40, resets_at: String(NOW) }, NOW)).toBeNull();
    expect(windowPace({ used_percentage: 40, resets_at: String(NOW - 60) }, NOW)).toBeNull();
    // More than a week ahead: the window has not started, no elapsed share yet.
    expect(
      windowPace({ used_percentage: 0, resets_at: String(NOW + WEEK_SECONDS) }, NOW),
    ).toBeNull();
  });

  it("clamps a usage past 100 % rather than reporting an impossible gap", () => {
    const p = windowPace(win(131, 3.5), NOW)!;
    expect(p.used).toBe(100);
    expect(p.delta).toBe(50);
    expect(p.fullAtSec).toBeNull(); // already full: nothing left to project
  });

  it("projects when the window fills — over pace only, never before 12 h of data", () => {
    // 3 days in, 60 % used → 20 %/day → the last 40 % take 2 days, before the reset (4 days out).
    const p = windowPace(win(60, 3), NOW)!;
    expect(p.verdict).toBe("over");
    expect(p.fullAtSec).toBe(NOW + 2 * DAY);
    expect(paceDetail(p, NOW)).toBe("full in 2d");
    // Under pace: no projection, the week resets first.
    expect(windowPace(win(20, 3), NOW)!.fullAtSec).toBeNull();
    // Too early: one busy first hours say nothing true about a whole week.
    const early = windowPace(
      { used_percentage: 20, resets_at: String(NOW + WEEK_SECONDS - PROJECTION_MIN_ELAPSED + 60) },
      NOW,
    )!;
    expect(early.verdict).toBe("over");
    expect(early.fullAtSec).toBeNull();
  });

  it("the projection lands strictly before the reset whenever the verdict is « over »", () => {
    // used > expected ⇔ the average rate fills the window before its reset — the identity the
    // module's header rests on. Sweep a grid of states to pin it.
    for (let d = 0.6; d < 7; d += 0.4) {
      for (let used = 1; used < 100; used += 3) {
        const p = windowPace(win(used, d), NOW);
        if (p?.verdict === "over" && p.fullAtSec !== null) {
          expect(p.fullAtSec).toBeLessThan(p.resetSec);
        }
      }
    }
  });
});

describe("delta wording", () => {
  it("labels the delta with its sign — « Δ » nomenclature", () => {
    expect(paceLabel(windowPace(win(62, 3.5), NOW)!)).toBe("Δ +12 pts");
    expect(paceLabel(windowPace(win(30, 3.5), NOW)!)).toBe("Δ −20 pts");
    expect(paceLabel(windowPace(win(50, 3.5), NOW)!)).toBe("Δ 0");
  });

  it("gives a signed terse figure, with a real minus sign", () => {
    expect(paceFigure(windowPace(win(62, 3.5), NOW)!)).toBe("+12");
    expect(paceFigure(windowPace(win(30, 3.5), NOW)!)).toBe("−20");
    expect(paceFigure(windowPace(win(50, 3.5), NOW)!)).toBe("0");
  });

  it("explains the figure from the numbers it is made of", () => {
    expect(paceExplain(windowPace(win(60, 3), NOW)!, NOW)).toBe(
      "43% of the week has passed, 60% of it is used. At this rate the window fills in 2d — before it resets in 4d.",
    );
    expect(paceExplain(windowPace(win(30, 3.5), NOW)!, NOW)).toBe(
      "50% of the week has passed, 30% of it is used. 20 pts below an even spend — budget to spare.",
    );
    expect(paceExplain(windowPace(win(50, 3.5), NOW)!, NOW)).toBe(
      "50% of the week has passed, 50% of it is used. Exactly on an even spend.",
    );
  });
});
