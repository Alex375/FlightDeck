import { beforeEach, describe, expect, it } from "vitest";
import type { PlanUsage } from "../ipc/client";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_PREFS,
  resolveDefaultAccountId,
  SWITCH_COOLDOWN_MS,
  atAccountSwitchBoundary,
  autoSwitchSuspended,
  blockedNotice,
  clearManualAccountPicks,
  decideSwitch,
  isTransientUsageError,
  manualAccountPick,
  noteManualAccountPick,
  usageForPolicy,
  useClaudeAccountPrefs,
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
    // Floors at 2, not 1: a trigger of 1 leaves no room for a ceiling strictly below it.
    expect(sanitizePrefs({ switchAtPercent: -5 }).switchAtPercent).toBe(2);
  });

  // The invariant itself, over every clamp path — including the ones the previous test
  // exercised but never checked the second half of.
  it("always keeps the ceiling strictly below the trigger", () => {
    const blobs: unknown[] = [
      {},
      { switchAtPercent: -5 },
      { switchAtPercent: 0 },
      { switchAtPercent: 1 },
      { switchAtPercent: 2 },
      { switchAtPercent: 999 },
      { switchAtPercent: 60, targetBelowPercent: 90 },
      { switchAtPercent: 90, targetBelowPercent: 90 },
      { targetBelowPercent: -3 },
      { switchAtPercent: "x", targetBelowPercent: NaN },
    ];
    for (const raw of blobs) {
      const p = sanitizePrefs(raw);
      expect(p.targetBelowPercent, JSON.stringify(raw)).toBeGreaterThanOrEqual(1);
      expect(p.targetBelowPercent, JSON.stringify(raw)).toBeLessThan(p.switchAtPercent);
    }
  });
});

describe("decideSwitch — exact boundaries", () => {
  const prefs = DEFAULT_ACCOUNT_PREFS; // 90 % trigger, 75 % ceiling

  // A `<` flipped to `<=` (or back) would move the switch by one point and pass every
  // test that only uses 89 / 91. These pin the comparison itself.
  it("switches AT the trigger, not only above it", () => {
    const res = decideSwitch(account(null, 90), [account("b", 10)], prefs);
    expect(res && "switchTo" in res).toBe(true);
  });

  it("refuses a candidate exactly AT the ceiling and accepts one just below", () => {
    expect(decideSwitch(account(null, 95), [account("b", 75)], prefs)).toEqual({
      blocked: { reason: "no_capacity", candidates: 1 },
    });
    const res = decideSwitch(account(null, 95), [account("b", 74)], prefs);
    expect(res && "switchTo" in res && res.switchTo.to.id).toBe("b");
  });
});

describe("decideSwitch — unreadable current account", () => {
  // A failed read on the account the conversation runs on must not be mistaken for
  // "below the threshold": that made the opt-in a permanent, silent no-op.
  it("reports it instead of doing nothing", () => {
    const current = { ...account(null, null), usageError: "keychain_denied" };
    const res = decideSwitch(current, [account("b", 10)], DEFAULT_ACCOUNT_PREFS);
    expect(res).toEqual({
      blocked: { reason: "unknown_current_usage", detail: "keychain_denied" },
    });
    expect(
      blockedNotice(current, { reason: "unknown_current_usage", detail: "keychain_denied" }),
    ).toContain("could not be read");
  });

  it("stays quiet when the endpoint simply reported no window (no error)", () => {
    expect(decideSwitch(account(null, null), [account("b", 10)], DEFAULT_ACCOUNT_PREFS)).toBeNull();
  });
});

describe("usageForPolicy", () => {
  const good = usage(40, 10);

  // A blip must not wipe the figure the policy acts on, nor surface as "could not be read"
  // in every thread: the query keeps polling and heals (or escalates) on its own.
  it("keeps the last good figure through transient failures, silently", () => {
    for (const kind of ["network", "http", "rate_limited"]) {
      expect(usageForPolicy({ data: good, error: { kind } }), kind).toEqual({
        usage: good,
        usageError: null,
      });
    }
    expect(usageForPolicy({ data: null, error: { kind: "network" } })).toEqual({
      usage: null,
      usageError: null,
    });
  });

  // An expired token only refreshes with a session on the account: whatever figure we hold
  // may be arbitrarily old. Unknown — so never a target — but nothing wrong to report.
  it("treats an expired token as unknown usage with nothing to report", () => {
    expect(usageForPolicy({ data: good, error: { kind: "token_expired" } })).toEqual({
      usage: null,
      usageError: null,
    });
    expect(isTransientUsageError("token_expired")).toBe(true);
  });

  it("drops the figure and reports a terminal cause", () => {
    for (const kind of ["no_token", "keychain_denied", "unauthorized", "parse", "unknown_account"]) {
      expect(usageForPolicy({ data: good, error: { kind } }), kind).toEqual({
        usage: null,
        usageError: kind,
      });
    }
  });

  it("passes a successful read through", () => {
    expect(usageForPolicy({ data: good, error: null })).toEqual({ usage: good, usageError: null });
  });
});

describe("atAccountSwitchBoundary", () => {
  const idle = (
    over: { busy?: boolean; activity?: string | null; awaiting?: boolean; queued?: boolean; perms?: number } = {},
  ) => ({
    state: {
      busy: over.busy ?? false,
      activity: over.activity ?? null,
      awaiting_permission: over.awaiting ?? false,
    },
    turns: { user_0: { queued: over.queued ?? false }, a1: {} },
    pendingPermissions: Array.from({ length: over.perms ?? 0 }),
  });

  it("accepts a session genuinely at rest", () => {
    expect(atAccountSwitchBoundary(idle(), 0, false)).toBe(true);
    expect(atAccountSwitchBoundary(undefined, 0, false)).toBe(true);
  });

  // `!busy` is not the boundary: between a `result` and the next queued turn the CLI is
  // idle for ~1 s, and a stop there throws the queued work away.
  it("refuses while anything is still pending", () => {
    expect(atAccountSwitchBoundary(idle({ busy: true }), 0, false)).toBe(false);
    expect(atAccountSwitchBoundary(idle({ activity: "requesting" }), 0, false)).toBe(false);
    expect(atAccountSwitchBoundary(idle({ awaiting: true }), 0, false)).toBe(false);
    expect(atAccountSwitchBoundary(idle({ perms: 1 }), 0, false)).toBe(false);
    expect(atAccountSwitchBoundary(idle({ queued: true }), 0, false)).toBe(false);
    expect(atAccountSwitchBoundary(idle(), 1, false)).toBe(false);
    expect(atAccountSwitchBoundary(undefined, 0, true)).toBe(false);
  });
});

describe("manual picks suspend the auto-switch", () => {
  beforeEach(() => {
    clearManualAccountPicks();
    useClaudeAccountPrefs.getState().set({ autoSwitch: false });
  });

  // Case A of the review: the user deliberately moves a conversation onto an account the
  // policy considers too full. The next evaluation must not revert it.
  it("pins a conversation to the account the user picked", () => {
    noteManualAccountPick("c1", "acct-a");
    expect(autoSwitchSuspended(manualAccountPick("c1"), "acct-a")).toBe(true);
    // Picking the DEFAULT account is a pick too.
    noteManualAccountPick("c2", null);
    expect(manualAccountPick("c2")).toBeNull();
    expect(autoSwitchSuspended(manualAccountPick("c2"), null)).toBe(true);
  });

  it("does not suspend a conversation the user never touched", () => {
    expect(manualAccountPick("never")).toBeUndefined();
    expect(autoSwitchSuspended(manualAccountPick("never"), null)).toBe(false);
  });

  // The pin protects a choice; once the conversation is no longer on that account for a
  // reason that was not the user's (e.g. the account was removed), it lapses.
  it("lapses when the conversation is no longer on the picked account", () => {
    noteManualAccountPick("c1", "acct-a");
    expect(autoSwitchSuspended(manualAccountPick("c1"), null)).toBe(false);
  });

  it("is released for the whole fleet when auto-switch is toggled", () => {
    noteManualAccountPick("c1", "acct-a");
    useClaudeAccountPrefs.getState().set({ autoSwitch: true });
    expect(manualAccountPick("c1")).toBeUndefined();

    noteManualAccountPick("c1", "acct-a");
    // Any other pref change keeps the pins.
    useClaudeAccountPrefs.getState().set({ switchAtPercent: 80 });
    expect(manualAccountPick("c1")).toBe("acct-a");
    useClaudeAccountPrefs.getState().set({ autoSwitch: false, switchAtPercent: 90 });
    expect(manualAccountPick("c1")).toBeUndefined();
  });
});

describe("resolveDefaultAccountId", () => {
  const known = [{ id: "acct-b" }];

  it("keeps a preference naming an account that exists", () => {
    expect(resolveDefaultAccountId("acct-b", known)).toBe("acct-b");
  });

  it("degrades a preference naming a removed account to the default one", () => {
    expect(resolveDefaultAccountId("gone", known)).toBeNull();
  });

  it("maps the reserved id and an empty preference to the default account", () => {
    expect(resolveDefaultAccountId(DEFAULT_ACCOUNT_ID, known)).toBeNull();
    expect(resolveDefaultAccountId(null, known)).toBeNull();
  });

  // The boot-time bug: an UNLOADED list was treated as empty, silently dropping a valid
  // preference for every conversation created before the list arrived.
  it("passes the preference through while the list is not loaded yet", () => {
    expect(resolveDefaultAccountId("acct-b", null)).toBe("acct-b");
  });
});
