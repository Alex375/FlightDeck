// Every state the side panel's Plan usage widget can be in, from the figures it read and the
// time. The component only draws this verdict, so these ARE the widget's behaviour.

import { describe, expect, it } from "vitest";
import type { PlanUsageError, PlanUsageInfo } from "../../../ui/kit";
import {
  displayPercent,
  planAccountName,
  planWidgetState,
  usageLevel,
  type PlanWidgetInput,
  type PlanWidgetView,
} from "./planWidgetState";

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const USAGE: PlanUsageInfo = {
  five_hour: { used_percentage: 42, resets_at: iso(NOW + 2 * 3600) },
  seven_day: { used_percentage: 67, resets_at: iso(NOW + 3 * 86400) },
  scoped: [{ label: "Fable", group: "weekly", window: { used_percentage: 0, resets_at: null } }],
};

function input(over: Partial<PlanWidgetInput> = {}): PlanWidgetInput {
  return {
    backend: "claude",
    remote: false,
    usage: USAGE,
    error: null,
    updatedAt: NOW_MS - 3 * 60_000,
    plan: null,
    ...over,
  };
}

const state = (over: Partial<PlanWidgetInput> = {}) => planWidgetState(input(over), NOW_MS);

function bars(v: PlanWidgetView) {
  if (v.body.kind !== "bars") throw new Error(`expected bars, got ${v.body.kind}`);
  return v.body;
}

describe("planWidgetState — no figure to show", () => {
  it("a remote conversation shows none, even with a local cache (another account's quota)", () => {
    const v = state({ remote: true });
    expect(v.body).toEqual({ kind: "remote" });
    expect(v.peak).toBeNull();
    expect(v.updatedAt).toBeNull();
    expect(v.hasFutureReset).toBe(false);
  });

  it("Codex before its first push waits, and never reports an error", () => {
    const err: PlanUsageError = { kind: "network", detail: "x" };
    const v = state({ backend: "codex", usage: null, updatedAt: null, error: err });
    expect(v.body).toEqual({ kind: "codex-waiting" });
    expect(v.peak).toBeNull();
  });

  it("Claude with nothing cached is « unloaded » — a dash, not a zero", () => {
    const v = state({ usage: null, updatedAt: 0 });
    expect(v.body).toEqual({ kind: "unloaded" });
    expect(v.peak).toBeNull();
    // TanStack's `0` means never.
    expect(v.updatedAt).toBeNull();
  });

  it("a failed read with nothing cached is an error", () => {
    const error: PlanUsageError = { kind: "keychain_denied", detail: "denied" };
    const v = state({ usage: null, error });
    expect(v.body).toEqual({ kind: "error", error });
  });

  it("a payload with no window reads « none reported » (or the error, when one came with it)", () => {
    const empty: PlanUsageInfo = { five_hour: null, seven_day: null, scoped: [] };
    expect(state({ usage: empty }).body).toEqual({ kind: "none-reported" });
    const error: PlanUsageError = { kind: "rate_limited", retry_after: 30 };
    expect(state({ usage: empty, error }).body).toEqual({ kind: "error", error });
  });
});

describe("planWidgetState — the windows", () => {
  it("draws every window PRESENT, in order: 5-hour, weekly, scoped caps", () => {
    const v = state();
    const b = bars(v);
    expect(b.rows.map((r) => r.label)).toEqual(["5-hour", "Weekly", "Fable · weekly"]);
    expect(b.rows.map((r) => r.pct)).toEqual([42, 67, 0]);
    expect(b.staleError).toBeNull();
    // A scoped cap that never started: a real 0 %, and no invented reset.
    expect(b.rows[2]).toMatchObject({ pct: 0, resetSec: null, scoped: true, past: false });
    expect(v.peak).toBe(67);
    expect(v.peakLevel).toBe("ok");
    expect(v.hasFutureReset).toBe(true);
  });

  it("ignores `is_active`: both windows show whichever one binds", () => {
    const withFlags = {
      five_hour: { used_percentage: 10, resets_at: null, is_active: false },
      seven_day: { used_percentage: 20, resets_at: null, is_active: true },
    } as unknown as PlanUsageInfo;
    const b = bars(state({ usage: withFlags }));
    expect(b.rows.map((r) => r.key)).toEqual(["five_hour", "seven_day"]);
  });

  it("draws only what exists — a lone weekly window, no scoped list", () => {
    const b = bars(
      state({ usage: { five_hour: null, seven_day: { used_percentage: 5, resets_at: null } } }),
    );
    expect(b.rows.map((r) => r.label)).toEqual(["Weekly"]);
  });

  it("keeps the header off scoped caps: a full model cap does not make the account full", () => {
    const v = state({
      usage: {
        five_hour: { used_percentage: 12, resets_at: null },
        seven_day: null,
        scoped: [{ label: "Fable", group: "weekly", window: { used_percentage: 100, resets_at: null } }],
      },
    });
    expect(v.peak).toBe(12);
    expect(bars(v).rows[1].level).toBe("full");
  });

  it("grades levels on the displayed figure and clamps the core's unclamped value", () => {
    expect(usageLevel(79)).toBe("ok");
    expect(usageLevel(80)).toBe("warn");
    expect(usageLevel(99)).toBe("warn");
    expect(usageLevel(100)).toBe("full");
    expect(displayPercent(99.6)).toBe(100);
    expect(displayPercent(130)).toBe(100);
    expect(displayPercent(-3)).toBe(0);
    const v = state({
      usage: { five_hour: { used_percentage: 131.2, resets_at: null }, seven_day: null },
    });
    expect(bars(v).rows[0]).toMatchObject({ pct: 100, level: "full" });
    expect(v.peak).toBe(100);
    expect(v.peakLevel).toBe("full");
  });

  it("reads an epoch-seconds reset (Codex) and an ISO one (Claude) alike", () => {
    const b = bars(
      state({
        backend: "codex",
        usage: {
          five_hour: { used_percentage: 30, resets_at: String(NOW + 600) },
          seven_day: { used_percentage: 50, resets_at: iso(NOW + 7200) },
          scoped: [],
        },
      }),
    );
    expect(b.rows.map((r) => r.resetSec)).toEqual([NOW + 600, NOW + 7200]);
  });
});

describe("planWidgetState — the words that count against now", () => {
  it("words each row's reset on the view's own clock", () => {
    const b = bars(state());
    expect(b.rows.map((r) => r.resetText)).toEqual(["resets in 2h00", "resets in 3d", null]);
  });

  it("dates the figures for the footer, and hides the line when never fetched", () => {
    expect(state().updatedText).toBe("3 min ago");
    expect(state({ usage: null, updatedAt: 0 }).updatedText).toBeNull();
    expect(state({ remote: true }).updatedText).toBeNull();
  });

  it("needs the clock while an « Updated … ago » line is shown, even with no reset ahead", () => {
    // No reset anywhere: without this, « Updated just now » would freeze on screen.
    const v = state({
      usage: { five_hour: { used_percentage: 10, resets_at: null }, seven_day: null },
    });
    expect(v.hasFutureReset).toBe(false);
    expect(v.needsClock).toBe(true);
    // Nothing relative to now on screen: no clock.
    expect(state({ usage: null, updatedAt: 0 }).needsClock).toBe(false);
    expect(state({ backend: "codex", usage: null, updatedAt: null }).needsClock).toBe(false);
    expect(state({ remote: true }).needsClock).toBe(false);
  });

  it("gives two caps with the same name distinct keys", () => {
    const b = bars(
      state({
        usage: {
          five_hour: null,
          seven_day: null,
          scoped: [
            { label: "Fable", group: null, window: { used_percentage: 1, resets_at: null } },
            { label: "Fable", group: null, window: { used_percentage: 2, resets_at: null } },
          ],
        },
      }),
    );
    const keys = b.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("planWidgetState — a window past its reset", () => {
  const usage: PlanUsageInfo = {
    five_hour: { used_percentage: 95, resets_at: iso(NOW - 60) },
    seven_day: { used_percentage: 40, resets_at: iso(NOW + 86400) },
  };

  it("flags the row « past » and keeps its stale figure out of the header", () => {
    const v = state({ usage });
    const b = bars(v);
    expect(b.rows[0]).toMatchObject({
      key: "five_hour",
      past: true,
      pct: 95,
      resetText: "resetting…",
    });
    expect(b.rows[1].past).toBe(false);
    expect(v.peak).toBe(40);
    expect(v.peakLevel).toBe("ok");
  });

  it("reads « — » in the header once every account window is past", () => {
    const v = state({
      usage: { ...usage, seven_day: { used_percentage: 40, resets_at: iso(NOW - 1) } },
    });
    expect(v.peak).toBeNull();
    // Nothing left to count down: the minute tick has no reason to run.
    expect(v.hasFutureReset).toBe(false);
  });

  it("a reset at exactly now is past", () => {
    const b = bars(
      state({ usage: { five_hour: { used_percentage: 1, resets_at: String(NOW) }, seven_day: null } }),
    );
    expect(b.rows[0].past).toBe(true);
  });
});

describe("planWidgetState — stale figures", () => {
  it("keeps the bars when a refresh fails after a success, and says so", () => {
    const error: PlanUsageError = { kind: "rate_limited", retry_after: null };
    const v = state({ error });
    expect(bars(v).staleError).toEqual(error);
    expect(bars(v).rows).toHaveLength(3);
    expect(v.peak).toBe(67);
    expect(v.peakStale).toBe(true);
    // The freshness line still dates the LAST success, not the failure.
    expect(v.updatedAt).toBe(NOW_MS - 3 * 60_000);
  });

  it("a Codex snapshot is never stale-flagged — the push has no error channel", () => {
    const v = state({ backend: "codex", error: { kind: "network", detail: "x" } });
    expect(bars(v).staleError).toBeNull();
    expect(v.peakStale).toBe(false);
  });
});

describe("planWidgetState — the coarse stream status (Claude)", () => {
  const limited = {
    status: "rejected",
    resetsAt: NOW + 1800,
    limitType: "five_hour",
    usingOverage: false,
  };

  it("lends its reset to the matching window that has none", () => {
    const b = bars(
      state({
        plan: limited,
        usage: {
          five_hour: { used_percentage: 100, resets_at: null },
          seven_day: { used_percentage: 20, resets_at: null },
        },
      }),
    );
    expect(b.rows[0].resetSec).toBe(NOW + 1800);
    expect(b.rows[1].resetSec).toBeNull();
  });

  it("says « Limit reached », even with nothing cached", () => {
    const v = state({ plan: limited, usage: null, updatedAt: null });
    expect(v.body.kind).toBe("unloaded");
    expect(v.notices).toEqual([
      { tone: "err", text: "Limit reached", resetSec: NOW + 1800, resetText: "resets in 30min" },
    ]);
    expect(v.hasFutureReset).toBe(true);
    // Its countdown is the only thing on screen that moves: the clock runs for it alone.
    expect(v.needsClock).toBe(true);
  });

  it("leaves « near limit » to the bars when there are bars", () => {
    const warn = { ...limited, status: "allowed_warning" };
    expect(state({ plan: warn }).notices).toEqual([]);
    expect(state({ plan: warn, usage: null }).notices).toEqual([
      { tone: "warn", text: "Near the plan's limit", resetSec: NOW + 1800, resetText: "resets in 30min" },
    ]);
  });

  it("drops a limit whose announced reset has PASSED — the sticky status is over", () => {
    const v = state({ plan: { ...limited, resetsAt: NOW - 5, usingOverage: true } });
    expect(v.notices).toEqual([
      { tone: "lo", text: "Overage active", resetSec: null, resetText: null },
    ]);
    const warn = state({
      plan: { ...limited, status: "allowed_warning", resetsAt: NOW },
      usage: null,
    });
    expect(warn.notices).toEqual([]);
  });

  it("keeps a limit that announced no reset: nothing says it lifted", () => {
    const v = state({ plan: { ...limited, resetsAt: null }, usage: null });
    expect(v.notices).toEqual([
      { tone: "err", text: "Limit reached", resetSec: null, resetText: null },
    ]);
    expect(v.hasFutureReset).toBe(false);
  });

  it("is ignored on a Codex conversation", () => {
    const v = state({ backend: "codex", plan: limited });
    expect(v.notices).toEqual([]);
  });
});

describe("planAccountName", () => {
  const base = {
    accountId: null,
    liveEmail: null,
    defaultCapturedEmail: null,
    record: null,
    mirrorLabel: null,
  };

  it("prefers the live address, then the captured one, then a label", () => {
    expect(planAccountName({ ...base, liveEmail: "a@x.io", defaultCapturedEmail: "b@x.io" })).toBe(
      "a@x.io",
    );
    expect(planAccountName({ ...base, defaultCapturedEmail: "b@x.io" })).toBe("b@x.io");
    expect(planAccountName(base)).toBe("Claude");
    expect(
      planAccountName({ ...base, accountId: "acc", record: { email: null, label: "Work" } }),
    ).toBe("Work");
    expect(planAccountName({ ...base, accountId: "acc", mirrorLabel: "Work 2" })).toBe("Work 2");
  });

  it("says an unknown account is unknown rather than passing for the default", () => {
    expect(planAccountName({ ...base, accountId: "gone" })).toBe("Unknown account");
  });
});
