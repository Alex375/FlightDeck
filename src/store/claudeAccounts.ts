// Multiple Claude accounts: the app-wide preferences and the PURE policy that decides
// when — and to which account — the app switches on its own.
//
// Split of ownership, deliberately:
//  - the ACCOUNT LIST and each conversation's account live in SQLite (the core owns them:
//    a spawn needs them, and they must survive a relaunch, a resume, a fork and a rewind);
//  - the PREFERENCES below are pure UI policy, so they follow the app's other prefs into
//    localStorage — no migration, no bindings, instantly reversible.
//
// Everything in the second half of this file is a pure function of a snapshot, so the
// thresholds, the tie-breaks and the anti-oscillation rules are unit-tested without a
// running app.

import { create } from "zustand";
import type { PlanUsage } from "../ipc/client";

const STORAGE_KEY = "tosse:accounts";

/** The reserved id of the CLI's own, un-scoped credential store — the account the user
 *  already had before this feature existed. Mirrors `accounts::DEFAULT_ACCOUNT_ID`.
 *  `null` on a conversation means exactly this account. */
export const DEFAULT_ACCOUNT_ID = "default";

export interface ClaudeAccountPrefs {
  /** The account a NEW Claude conversation starts on. `null` = the default (un-scoped)
   *  account, i.e. the unchanged behaviour. Only affects conversations created from now
   *  on: an existing one keeps whatever it was already running against. An id pointing at
   *  a removed account degrades to `null` rather than failing the spawn — see
   *  {@link resolveDefaultAccountId}. */
  defaultAccountId: string | null;
  /** Switch a conversation to another account when the one it runs on nears its limit.
   *  OFF by default: it changes which subscription the work is billed against, so it is
   *  opt-in per the project's user-control principle, and turning it back off restores
   *  the manual behaviour immediately (nothing to undo — it only gates future switches). */
  autoSwitch: boolean;
  /** Percentage of a window (5h or 7d) at which the current account counts as "near its
   *  limit" and a switch is armed. */
  switchAtPercent: number;
  /** A candidate account must be BELOW this to be worth switching to. Strictly lower than
   *  `switchAtPercent`, which is what makes the policy anti-oscillating: without the gap,
   *  an account at 89 % would be picked and immediately re-trigger a switch back. */
  targetBelowPercent: number;
}

export const DEFAULT_ACCOUNT_PREFS: ClaudeAccountPrefs = {
  defaultAccountId: null,
  autoSwitch: false,
  switchAtPercent: 90,
  targetBelowPercent: 75,
};

/** The account a new conversation should start on, given the accounts that actually
 *  exist. An id left over from a removed account resolves to `null` (the default account)
 *  instead of being handed to a spawn that would refuse it — the pref is a preference, not
 *  a constraint, so a stale one degrades rather than blocking work. */
export function resolveDefaultAccountId(
  preferred: string | null,
  /** `null` = the list has NOT been loaded yet. That is not "no accounts": treating it as
   *  empty would silently drop a perfectly valid preference for every conversation created
   *  before the list arrived. An unloaded list passes the preference through, and the
   *  spawn-side check stays the single authority on whether the account still exists. */
  known: readonly { id: string }[] | null,
): string | null {
  if (!preferred || preferred === DEFAULT_ACCOUNT_ID) return null;
  if (known === null) return preferred;
  return known.some((a) => a.id === preferred) ? preferred : null;
}

/** Clamp a stored blob back into a usable shape. A hand-edited or partially-written
 *  localStorage entry must degrade to the defaults rather than feed NaN thresholds into
 *  the policy (where every comparison would silently read false and the switch would
 *  simply never fire — the worst kind of failure: invisible). */
export function sanitizePrefs(raw: unknown): ClaudeAccountPrefs {
  const p = (raw ?? {}) as Partial<ClaudeAccountPrefs>;
  const pct = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(hi, Math.max(lo, Math.round(v)))
      : fallback;
  // The trigger floors at 2 so a ceiling STRICTLY below it (≥ 1) always exists. With a
  // floor of 1 the clamp produced trigger = ceiling = 1: the hysteresis gap — the whole
  // anti-oscillation guarantee — silently gone on exactly the corrupt-blob path this
  // function exists to repair.
  const switchAt = pct(p.switchAtPercent, DEFAULT_ACCOUNT_PREFS.switchAtPercent, 2, 100);
  // Keep the gap even if the stored pair was inverted: a ceiling at or above the trigger
  // would make the policy oscillate between two equally-loaded accounts.
  const target = Math.min(
    pct(p.targetBelowPercent, DEFAULT_ACCOUNT_PREFS.targetBelowPercent, 1, 99),
    switchAt - 1,
  );
  return {
    defaultAccountId:
      typeof p.defaultAccountId === "string" && p.defaultAccountId ? p.defaultAccountId : null,
    autoSwitch: p.autoSwitch === true,
    switchAtPercent: switchAt,
    targetBelowPercent: target,
  };
}

function load(): ClaudeAccountPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_ACCOUNT_PREFS };
  }
}

function save(prefs: ClaudeAccountPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A full / unavailable localStorage must not break the toggle for this session.
  }
}

interface ClaudeAccountsState extends ClaudeAccountPrefs {
  set: (patch: Partial<ClaudeAccountPrefs>) => void;
}

export const useClaudeAccountPrefs = create<ClaudeAccountsState>((set, get) => ({
  ...load(),
  set: (patch) => {
    const next = sanitizePrefs({ ...get(), ...patch });
    // Toggling auto-switch is the user re-stating the policy for the whole fleet: every
    // per-conversation pin a manual pick left behind is released, so turning it back on
    // really does resume watching every conversation.
    if (next.autoSwitch !== get().autoSwitch) clearManualAccountPicks();
    save(next);
    set(next);
  },
}));

// ── Manual picks vs the auto-switch ──────────────────────────────────────────────────

/** The account the USER last picked for a conversation (convId → account, `null` = the
 *  default one). In memory, like `lastAccountSwitchAt`: it is a runtime truce between the
 *  user and the policy, not a preference to carry across a relaunch.
 *
 *  Without it, a deliberate pick of an account the policy considers too full was reverted
 *  on the very next render (with a "Switched" notice), and after an auto-switch the user's
 *  pick back could be silently ignored. */
const manualPicks = new Map<string, string | null>();

/** Record that the user explicitly chose `accountId` for `convId`. */
export function noteManualAccountPick(convId: string, accountId: string | null): void {
  manualPicks.set(convId, accountId);
}

/** Release every manual pin (auto-switch toggled). */
export function clearManualAccountPicks(): void {
  manualPicks.clear();
}

/** The account the user pinned `convId` to, or `undefined` when they never picked one. */
export function manualAccountPick(convId: string): string | null | undefined {
  return manualPicks.has(convId) ? (manualPicks.get(convId) ?? null) : undefined;
}

/** Whether the auto-switch must leave a conversation alone because the user chose its
 *  account. Holds only while the conversation is STILL on the account they picked: a later
 *  change that did not come from them (the account was removed and the conversation fell
 *  back to the default) lifts the pin, since the choice it protected no longer stands. */
export function autoSwitchSuspended(
  pick: string | null | undefined,
  currentAccountId: string | null,
): boolean {
  return pick !== undefined && pick === currentAccountId;
}

/** Read the prefs OUTSIDE React (the auto-switch controller runs off store events). */
export function accountPrefs(): ClaudeAccountPrefs {
  const { defaultAccountId, autoSwitch, switchAtPercent, targetBelowPercent } =
    useClaudeAccountPrefs.getState();
  return { defaultAccountId, autoSwitch, switchAtPercent, targetBelowPercent };
}

// ── The account list, mirrored out of React ──────────────────────────────────────────

/** A live mirror of the accounts the core persists, so code OUTSIDE React (creating a
 *  conversation, the auto-switch controller) can read the list without a round-trip. The
 *  query in `useAccounts.ts` is the single writer; this is a cache, never the source of
 *  truth. Empty until the first fetch — callers must treat "empty" as "not loaded yet or
 *  genuinely none", which is safe here because both mean "use the default account". */
export const useClaudeAccountList = create<{
  /** `null` until the list has been loaded once (seeded at boot from the persisted state,
   *  then kept fresh by the query) — never conflated with "loaded, and empty". */
  accounts: ClaudeAccountSummary[] | null;
  setAccounts: (accounts: ClaudeAccountSummary[]) => void;
}>((set) => ({
  accounts: null,
  setAccounts: (accounts) => set({ accounts }),
}));

/** The non-sensitive fields of a persisted account the UI and the policy need. */
export interface ClaudeAccountSummary {
  id: string;
  label: string;
  sortIndex: number;
}

/** Project a persisted record onto the summary the mirror holds. One definition, shared by
 *  the boot seeding and the query, so the two writers can never shape it differently. */
export function toAccountSummary(a: {
  id: string;
  label: string;
  sort_index: number;
}): ClaudeAccountSummary {
  return { id: a.id, label: a.label, sortIndex: a.sort_index };
}

/** Read the account list outside React (`null` = not loaded yet). */
export function claudeAccountList(): ClaudeAccountSummary[] | null {
  return useClaudeAccountList.getState().accounts;
}

/** The account a conversation created right now should run on: the user's chosen default,
 *  validated against the accounts that exist.
 *
 *  `remote`: the conversation lives in a REMOTE (SSH) repo. It then always starts on the
 *  default account — the account is a local environment variable the SSH launcher does not
 *  carry, so the core refuses any other one there, and seeding the preference would leave
 *  the conversation unable to send its first message. */
export function defaultAccountForNewConversation(opts?: { remote?: boolean }): string | null {
  if (opts?.remote) return null;
  return resolveDefaultAccountId(accountPrefs().defaultAccountId, claudeAccountList());
}

// ── The switching policy (pure) ──────────────────────────────────────────────────────

/** What one account looks like to the policy. `usage` is `null` when we have no figure
 *  for it — never a 0: an account we cannot measure is UNKNOWN, and treating unknown as
 *  empty would send work to an account that might already be exhausted. */
export interface AccountUsageSnapshot {
  /** `null` = the default (un-scoped) account. */
  id: string | null;
  label: string;
  /** Whether the account is actually signed in. A signed-out account can never be a
   *  switch target — the session would fail to start. */
  loggedIn: boolean;
  usage: PlanUsage | null;
  /** Why the figures could not be read, when they could not (e.g. `keychain_denied`). Kept
   *  so an unmeasurable CURRENT account is reported rather than read as "below the
   *  threshold" — see {@link decideSwitch}. */
  usageError?: string | null;
  /** When the figures were last fetched successfully (ms). Stale data is not a reason to
   *  refuse a switch, but it IS a reason to prefer a freshly-measured candidate. */
  fetchedAt: number | null;
  /** Display order, the deterministic tie-break between equally-loaded accounts. */
  sortIndex: number;
}

/** The highest fill across an account's windows — the one that will bind first. `null`
 *  when nothing was reported (see {@link AccountUsageSnapshot.usage}). Model-scoped caps
 *  are deliberately EXCLUDED: they cap one model, not the account, so a full Fable
 *  allowance must not read as "this account is exhausted" and trigger a switch. */
export function peakUsagePercent(usage: PlanUsage | null): number | null {
  if (!usage) return null;
  const windows = [usage.five_hour, usage.seven_day].filter(
    (w): w is NonNullable<typeof w> => !!w,
  );
  if (windows.length === 0) return null;
  return Math.max(...windows.map((w) => w.used_percentage));
}

/** Why the app moved a conversation to another account — carried into the notice shown in
 *  the thread, so a switch is never something the user has to infer. */
export interface SwitchDecision {
  from: AccountUsageSnapshot;
  to: AccountUsageSnapshot;
  /** The peak percentage that armed the switch, for the notice text. */
  fromPercent: number;
  toPercent: number;
}

/** Why NO switch happened, when one was armed. Surfaced to the user rather than swallowed:
 *  "your account is nearly full and nothing was done" is exactly the moment they need to
 *  know. `null` from {@link decideSwitch} means the account simply isn't near its limit. */
export type SwitchBlocked =
  | { reason: "no_other_account" }
  | { reason: "no_capacity"; candidates: number }
  | { reason: "unknown_usage"; candidates: number }
  /** The account the conversation RUNS on cannot be measured. Distinct from "below the
   *  threshold": the opt-in would otherwise be a permanent, invisible no-op on exactly the
   *  account it is supposed to protect. */
  | { reason: "unknown_current_usage"; detail: string | null };

/**
 * Decide whether to move off `current`, and to which account.
 *
 * The rules, in order:
 *  1. no switch unless `current`'s peak window is at or above `switchAtPercent`;
 *  2. a candidate must be a DIFFERENT account, signed in, with a KNOWN figure strictly
 *     below `targetBelowPercent` (the hysteresis gap: see the pref's doc);
 *  3. among those, the emptiest wins; ties break on `sortIndex`, so the choice is
 *     deterministic and the same input never yields two different answers.
 *
 * An account whose usage is unknown is never chosen: switching to it could land on an
 * account already over its limit, and the next measurement would bounce the conversation
 * straight back — the oscillation this policy exists to prevent.
 */
export function decideSwitch(
  current: AccountUsageSnapshot,
  others: AccountUsageSnapshot[],
  prefs: ClaudeAccountPrefs,
): { switchTo: SwitchDecision } | { blocked: SwitchBlocked } | null {
  const currentPct = peakUsagePercent(current.usage);
  // A FAILED read is not "below the threshold". (No figure and no error = the endpoint
  // reported no window at all — nothing to act on, and nothing wrong to report.)
  if (currentPct === null) {
    return current.usageError
      ? { blocked: { reason: "unknown_current_usage", detail: current.usageError } }
      : null;
  }
  if (currentPct < prefs.switchAtPercent) return null;

  const candidates = others.filter((a) => a.id !== current.id && a.loggedIn);
  if (candidates.length === 0) return { blocked: { reason: "no_other_account" } };

  const measured = candidates
    .map((a) => ({ account: a, pct: peakUsagePercent(a.usage) }))
    .filter((c): c is { account: AccountUsageSnapshot; pct: number } => c.pct !== null);
  if (measured.length === 0) {
    return { blocked: { reason: "unknown_usage", candidates: candidates.length } };
  }

  const roomy = measured.filter((c) => c.pct < prefs.targetBelowPercent);
  if (roomy.length === 0) {
    return { blocked: { reason: "no_capacity", candidates: candidates.length } };
  }

  roomy.sort((a, b) => a.pct - b.pct || a.account.sortIndex - b.account.sortIndex);
  const best = roomy[0];
  return {
    switchTo: {
      from: current,
      to: best.account,
      fromPercent: currentPct,
      toPercent: best.pct,
    },
  };
}

/** Usage-read failures a later poll can plausibly heal. Reporting them would post a notice
 *  on every blip (and again on every blip after a recovery), so the policy never reports
 *  them: it keeps acting on the last good figure, or on none at all. */
const TRANSIENT_USAGE_ERRORS = new Set(["network", "http", "rate_limited", "token_expired"]);

/** Whether a usage-read failure is one the auto-switch should stay quiet about. */
export function isTransientUsageError(kind: string): boolean {
  return TRANSIENT_USAGE_ERRORS.has(kind);
}

/** Turn one account's usage query into what the policy may act on.
 *
 *  - success → the figure;
 *  - a network / HTTP / rate-limit blip → the LAST GOOD figure (the query keeps polling, so
 *    it is refreshed, or escalates to a terminal cause, on its own);
 *  - `token_expired` → unknown, with no error: the stored token only refreshes when a
 *    session runs on the account, so any old figure may be arbitrarily stale — never a
 *    switch target, and nothing wrong to report;
 *  - a TERMINAL cause (no token, Keychain refused, 401, unreadable body, removed account) →
 *    no figure AND the error, which is what the policy reports: polling has stopped, and an
 *    old figure would otherwise freeze the account at a stale measurement forever. */
export function usageForPolicy(q: {
  data: PlanUsage | null;
  error: { kind: string } | null;
}): { usage: PlanUsage | null; usageError: string | null } {
  if (!q.error) return { usage: q.data, usageError: null };
  if (q.error.kind === "token_expired") return { usage: null, usageError: null };
  if (isTransientUsageError(q.error.kind)) return { usage: q.data, usageError: null };
  return { usage: null, usageError: q.error.kind };
}

/** What the safe-boundary check reads from a conversation's live session entry. */
export interface BoundarySession {
  state: { busy: boolean; activity: string | null; awaiting_permission: boolean };
  turns: Record<string, { queued?: boolean }>;
  pendingPermissions: readonly unknown[];
}

/**
 * Whether a live conversation is at a boundary where its process may be restarted onto
 * another account (or have its account decided for it).
 *
 * `!busy` alone is NOT that boundary: a `result` hands control back for a moment, and the
 * CLI takes it straight back for anything it has queued — a message sent mid-turn, a
 * `<task-notification>`, an unmet `/goal` — within ~1 s. Killing the process in that gap
 * throws the queued work away. So every sign of pending work must be clear:
 *  - `busy` (a turn in flight — set by the core the moment a message is written, which also
 *    covers a first message racing a just-bound handle),
 *  - `activity` (the CLI already started the next model call, ~50 ms after the result),
 *  - a permission prompt waiting on the user,
 *  - a user message still QUEUED in the CLI,
 *  - a background task, still working against the account being left,
 *  - a spawn in flight.
 *
 * This is a snapshot test: callers that act on it must wait a settle delay and re-check
 * against FRESH state before stopping anything (see `ClaudeAccountApplyHost`).
 */
export function atAccountSwitchBoundary(
  session: BoundarySession | undefined,
  backgroundRunning: number,
  spawning: boolean,
): boolean {
  if (spawning || backgroundRunning > 0) return false;
  // No entry yet: nothing has streamed for this process and nothing was sent through it.
  if (!session) return true;
  const { state } = session;
  if (state.busy || state.activity !== null || state.awaiting_permission) return false;
  if (session.pendingPermissions.length > 0) return false;
  for (const id in session.turns) if (session.turns[id].queued) return false;
  return true;
}

/** How long a conversation is left alone after a switch, whatever the figures say. The
 *  usage endpoint is polled every few minutes, so without this a conversation could be
 *  moved again on the very next tick — before the account it just moved to has had any
 *  usage attributed to it. Belt to the hysteresis gap, not a replacement for it. */
export const SWITCH_COOLDOWN_MS = 10 * 60_000;

/** Whether a conversation may be switched again, given when it last was. */
export function switchCooldownElapsed(lastSwitchAt: number | null, now: number): boolean {
  return lastSwitchAt === null || now - lastSwitchAt >= SWITCH_COOLDOWN_MS;
}

/** The sentence shown in the thread when a switch actually lands. Names both accounts and
 *  the quota reason — never a token, an email the user did not choose to display, or any
 *  other detail from the credential store. */
export function switchNotice(d: SwitchDecision): string {
  return `Switched Claude account: ${d.from.label} (${Math.round(d.fromPercent)}% used) → ${d.to.label} (${Math.round(d.toPercent)}% used).`;
}

/** The sentence shown when a switch was armed but could not happen. Says what is wrong AND
 *  what the user can do — an approaching limit with no fallback must never be silent. */
export function blockedNotice(current: AccountUsageSnapshot, b: SwitchBlocked): string {
  const head = `Claude account ${current.label} is near its usage limit`;
  switch (b.reason) {
    case "no_other_account":
      return `${head}, and no other account is signed in. Add one in Settings → Accounts to keep working.`;
    case "no_capacity":
      return `${head}, and the ${b.candidates === 1 ? "other account is" : `${b.candidates} other accounts are`} too close to their own limit to switch to.`;
    case "unknown_usage":
      return `${head}, but the usage of the other ${b.candidates === 1 ? "account" : "accounts"} could not be read, so no switch was made. Check Settings → Accounts.`;
    case "unknown_current_usage":
      return `The usage of Claude account ${current.label} could not be read${b.detail ? ` (${b.detail})` : ""}, so auto-switch cannot tell when it nears its limit. Check Settings → Accounts.`;
  }
}
