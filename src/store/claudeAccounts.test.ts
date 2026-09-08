import { describe, expect, it } from "vitest";
import type { PlanUsage } from "../ipc/client";
import {
  DEFAULT_ACCOUNT_PREFS,
  SWITCH_COOLDOWN_MS,
  blockedNotice,
  decideSwitch,
  peakUsagePercent,
  sanitizePrefs,
  switchCooldownElapsed,
  switchNotice,
  type AccountUsageSnapshot,
} from "./claudeAccounts";

const usage = (fiveHour: number | null, sevenDay: number | null): PlanUsage => ({
  five_hour: fiveHour === null ? null : { used_percentage: fiveHour, resets_at: null },
  seven_day: sevenDay === null ? null : { used_percentage: sevenDay, resets_at: null },
  scoped: [],
});

const account = (
  id: string | null,
  pct: number | null,
  extra: Partial<AccountUsageSnapshot> = {},
): AccountUsageSnapshot => ({
  id,
  label: id ?? "Default",
  loggedIn: true,
  usage: pct === null ? null : usage(pct, 0),
  fetchedAt: 1,
  sortIndex: 0,
  ...extra,
});

describe("peakUsagePercent", () => {
  it("takes the window that binds first", () => {
    expect(peakUsagePercent(usage(30, 80))).toBe(80);
    expect(peakUsagePercent(usage(95, 10))).toBe(95);
  });

  it("is null when nothing was reported — unknown is never zero", () => {
    expect(peakUsagePercent(null)).toBeNull();
    expect(peakUsagePercent(usage(null, null))).toBeNull();
  });

  // A model-scoped cap limits ONE model, not the account. Counting it would let a full
  // Fable allowance read as "this account is exhausted" and move every conversation off a
  // subscription that is in fact nearly empty.
  it("ignores model-scoped caps", () => {
    const withScoped: PlanUsage = {
      ...usage(10, 20),
      scoped: [{ label: "Fable", group: "weekly", window: { used_percentage: 100, resets_at: null } }],
    };
    expect(peakUsagePercent(withScoped)).toBe(20);
  });
});

describe("decideSwitch", () => {
  const prefs = DEFAULT_ACCOUNT_PREFS; // 90 % trigger, 75 % ceiling

  it("does nothing below the threshold", () => {
    expect(decideSwitch(account(null, 89), [account("b", 10)], prefs)).toBeNull();
  });

  it("switches at the threshold, to the emptiest account", () => {
    const res = decideSwitch(
      account(null, 91),
      [account("b", 60), account("c", 12), account("d", 40)],
      prefs,
    );
    expect(res && "switchTo" in res && res.switchTo.to.id).toBe("c");
    expect(res && "switchTo" in res && res.switchTo.fromPercent).toBe(91);
  });

  // Determinism matters: the same fleet must not produce a different answer per run, or
  // two conversations armed by the same tick would scatter across accounts.
  it("breaks ties on sort order, not map order", () => {
    const a = decideSwitch(
      account(null, 95),
      [account("late", 20, { sortIndex: 9 }), account("early", 20, { sortIndex: 1 })],
      prefs,
    );
    const b = decideSwitch(
      account(null, 95),
      [account("early", 20, { sortIndex: 1 }), account("late", 20, { sortIndex: 9 })],
      prefs,
    );
    expect(a && "switchTo" in a && a.switchTo.to.id).toBe("early");
    expect(b && "switchTo" in b && b.switchTo.to.id).toBe("early");
  });

  // The hysteresis gap IS the anti-oscillation rule: an account between the ceiling and
  // the trigger is not empty enough to be worth moving to, because the very next
  // measurement would arm a switch back.
  it("refuses a candidate inside the hysteresis gap", () => {
    const res = decideSwitch(account(null, 92), [account("b", 80)], prefs);
    expect(res).toEqual({ blocked: { reason: "no_capacity", candidates: 1 } });
  });

  it("never picks an account whose usage is unknown", () => {
    const res = decideSwitch(account(null, 92), [account("b", null)], prefs);
    expect(res).toEqual({ blocked: { reason: "unknown_usage", candidates: 1 } });
  });

  it("never picks a signed-out account", () => {
    const res = decideSwitch(
      account(null, 92),
      [account("b", 5, { loggedIn: false })],
      prefs,
    );
    expect(res).toEqual({ blocked: { reason: "no_other_account" } });
  });

  it("reports having nowhere to go rather than staying silent", () => {
    const res = decideSwitch(account(null, 99), [], prefs);
    expect(res).toEqual({ blocked: { reason: "no_other_account" } });
    expect(blockedNotice(account(null, 99), { reason: "no_other_account" })).toContain(
      "Settings → Accounts",
    );
  });

  it("does not switch an account to itself", () => {
    const self = account("a", 95);
    expect(decideSwitch(self, [self], DEFAULT_ACCOUNT_PREFS)).toEqual({
      blocked: { reason: "no_other_account" },
    });
  });
});

describe("switch notices", () => {
  it("names both accounts and the quota reason, and no secret", () => {
    const text = switchNotice({
      from: account(null, 93),
      to: account("b", 12),
      fromPercent: 93,
      toPercent: 12,
    });
    expect(text).toContain("Default");
    expect(text).toContain("b");
    expect(text).toContain("93%");
    expect(text).toContain("12%");
  });
});

describe("cooldown", () => {
  it("leaves a freshly switched conversation alone", () => {
    expect(switchCooldownElapsed(1_000, 1_000 + SWITCH_COOLDOWN_MS - 1)).toBe(false);
    expect(switchCooldownElapsed(1_000, 1_000 + SWITCH_COOLDOWN_MS)).toBe(true);
    expect(switchCooldownElapsed(null, 0)).toBe(true);
  });
});

describe("sanitizePrefs", () => {
  it("defaults to OFF", () => {
    expect(sanitizePrefs({}).autoSwitch).toBe(false);
  });

  // A NaN threshold would make every comparison read false: the switch would simply never
  // fire, invisibly. Clamping is what keeps a corrupt blob from disabling the feature.
  it("repairs a corrupt blob instead of producing NaN thresholds", () => {
    const p = sanitizePrefs({ switchAtPercent: "oops", targetBelowPercent: null } as never);
    expect(p.switchAtPercent).toBe(DEFAULT_ACCOUNT_PREFS.switchAtPercent);
    expect(p.targetBelowPercent).toBe(DEFAULT_ACCOUNT_PREFS.targetBelowPercent);
  });

  it("keeps the hysteresis gap even when the stored pair is inverted", () => {
    const p = sanitizePrefs({ switchAtPercent: 60, targetBelowPercent: 90 });
    expect(p.targetBelowPercent).toBeLessThan(p.switchAtPercent);
  });

  it("clamps out-of-range percentages", () => {
    expect(sanitizePrefs({ switchAtPercent: 999 }).switchAtPercent).toBe(100);
    expect(sanitizePrefs({ switchAtPercent: -5 }).switchAtPercent).toBe(1);
  });
});
