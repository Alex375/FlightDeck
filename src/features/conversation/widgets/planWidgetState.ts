// What the side panel's Plan usage widget shows, derived PURELY from the plan figures it read and
// the time — no React, no store — so every state (remote, Codex before its first push, never
// loaded, failed, stale, a window past its reset) is pinned by tests. The component renders the
// verdict and decides nothing.
//
// ⚠️ PRESENCE, never `is_active`. A window is drawn iff its object is in the payload; the
// endpoint's `is_active` only marks which ONE limit binds right now and flips between the 5-hour
// and the weekly window over time (see usage/mod.rs), so gating on it would only ever show one of
// them. The payload types here do not even carry the flag.
//
// ⚠️ Unknown is not zero. No payload reads « — », never « 0 % »; a scoped cap at 0 % with no reset
// is a REAL reading (a window that has not started) and is drawn as one.

import type { PlanInfo, PlanUsageError, PlanUsageInfo, PlanUsageWindow } from "../../../ui/kit";
import { peakUsagePercent } from "../../../store/claudeAccounts";
import {
  accountWindowLabel,
  fmtAgo,
  fmtReset,
  resetToEpochSeconds,
  scopedUsageLabel,
} from "../../../ui/planUsageFormat";

/** From here a window reads as near its limit — the threshold the popover's bars, Settings →
 *  Accounts and the account chip warn at. */
export const WARN_PERCENT = 80;
/** A window at its limit: turns will be refused (or billed as overage) until it resets. */
export const FULL_PERCENT = 100;

/** How loud a percentage is: the accent at rest, amber near the limit, red at it. */
export type UsageLevel = "ok" | "warn" | "full";

/** The level of a DISPLAYED (clamped, rounded) percentage — graded on what the user reads, so a
 *  bar never says « 100 % » in amber or « 80 % » in the accent. */
export function usageLevel(pct: number): UsageLevel {
  if (pct >= FULL_PERCENT) return "full";
  if (pct >= WARN_PERCENT) return "warn";
  return "ok";
}

/** A raw `used_percentage` as shown: the core does NOT clamp it (it can be fractional, or pass
 *  100), so the UI does — 0–100, rounded, like the popover. */
export function displayPercent(raw: number): number {
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/** One window's block: label and figure over a bar, and its reset under it. */
export interface PlanWidgetRow {
  key: string;
  /** « 5-hour », « Weekly », « Fable · weekly ». */
  label: string;
  /** Clamped and rounded — the figure shown AND the bar's width. */
  pct: number;
  level: UsageLevel;
  /** When the window resets (epoch SECONDS), or `null` when unknown — a scoped cap that has
   *  never started reports none, and one is never invented. */
  resetSec: number | null;
  /** Its reset time has PASSED: the figure belongs to a window that is over, and the next fetch
   *  or push will replace it. Drawn « resetting… » and dimmed — never as a fresh reading. */
  past: boolean;
  /** The line under the bar: « resets in 2h14 », « resetting… » once past, `null` when the reset
   *  is unknown. Worded HERE, on the same clock as `past`, so the two can never disagree (a row
   *  the view calls live reading « resets imminent »). */
  resetText: string | null;
  /** A model-scoped cap rather than an account-wide window. */
  scoped: boolean;
}

/** A line under the bars from the coarse stream status (`rate_limit_event`) — Claude's only
 *  signal that the plan is refusing turns, which the % alone can lag behind. */
export interface PlanWidgetNotice {
  tone: "err" | "warn" | "lo";
  text: string;
  /** The reset the CLI announced with it (epoch seconds), when it did and it is still ahead. */
  resetSec: number | null;
  /** « resets in 2h14 », or `null` with no reset ahead. */
  resetText: string | null;
}

/** What the body shows. */
export type PlanWidgetBody =
  /** Billed to a remote server's own account — unreadable from this Mac. */
  | { kind: "remote" }
  /** Codex has not pushed its limits since the app started. */
  | { kind: "codex-waiting" }
  /** Claude, nothing cached: « — » and a deliberate Load. */
  | { kind: "unloaded" }
  /** The read failed and there is nothing to show instead. */
  | { kind: "error"; error: PlanUsageError }
  /** A payload arrived, but with no window in it. */
  | { kind: "none-reported" }
  /** The windows. `staleError`: the LAST refresh failed, so these are last-known figures. */
  | { kind: "bars"; rows: PlanWidgetRow[]; staleError: PlanUsageError | null };

export interface PlanWidgetView {
  body: PlanWidgetBody;
  /** The header's reading: the peak of the 5-hour and weekly windows (scoped caps excluded, as in
   *  `peakUsagePercent` — a full Fable allowance does not make the account full), windows past
   *  their reset excluded. `null` → « — ». */
  peak: number | null;
  peakLevel: UsageLevel;
  /** The peak is a last-known figure: the last refresh failed. */
  peakStale: boolean;
  notices: PlanWidgetNotice[];
  /** When the shown figures were last fetched / pushed (ms), `null` = never. */
  updatedAt: number | null;
  /** « 3 min ago » for the footer, `null` = never fetched (the line is then left out). */
  updatedText: string | null;
  /** Some reset is still AHEAD — a countdown to move, or a row to flip to « resetting… ». */
  hasFutureReset: boolean;
  /** Something on screen reads relative to NOW — a reset ahead, or the « Updated … ago » line —
   *  so the widget's minute tick has a reason to run. ⚠️ Not just `hasFutureReset`: a payload
   *  whose windows carry no reset (or are all past) would otherwise freeze « Updated just now »
   *  on screen for as long as the body stays open — a freshness claim that is no longer true. */
  needsClock: boolean;
}

export interface PlanWidgetInput {
  backend: "claude" | "codex";
  remote: boolean;
  usage: PlanUsageInfo | null;
  error: PlanUsageError | null;
  /** When the shown figures were last fetched / pushed (ms). `0` is read as never. */
  updatedAt: number | null;
  /** The coarse stream status (Claude only; ignored for Codex): a fallback reset for a window
   *  the payload gives none, and the « limited » signal. */
  plan?: PlanInfo | null;
}

/**
 * The name the widget gives the account its figures belong to — the same precedence as the
 * composer's account chip: the address read with the account's own token, then the address
 * captured at sign-in, then a label. An id no longer in the list says so rather than passing for
 * the default account.
 */
export function planAccountName(a: {
  /** `null` = the default (un-scoped) account. */
  accountId: string | null;
  /** The live identity's address, when its query is cached. */
  liveEmail: string | null;
  /** Default account: the address captured at its sign-in. */
  defaultCapturedEmail: string | null;
  /** Extra account: its persisted record, when the list is cached. */
  record: { email: string | null; label: string } | null;
  /** Extra account: its label from the always-loaded account mirror. */
  mirrorLabel: string | null;
}): string {
  if (a.liveEmail) return a.liveEmail;
  if (a.accountId === null) return a.defaultCapturedEmail ?? "Claude";
  return a.record?.email ?? a.record?.label ?? a.mirrorLabel ?? "Unknown account";
}

/** Build one row from a window. */
function row(
  key: string,
  label: string,
  w: PlanUsageWindow,
  fallbackReset: number | null,
  scoped: boolean,
  nowSec: number,
): PlanWidgetRow {
  const pct = displayPercent(w.used_percentage);
  const resetSec = resetToEpochSeconds(w.resets_at) ?? fallbackReset;
  const past = resetSec !== null && resetSec <= nowSec;
  return {
    key,
    label,
    pct,
    level: usageLevel(pct),
    resetSec,
    past,
    resetText: resetSec === null ? null : past ? "resetting…" : `resets ${fmtReset(resetSec, nowSec)}`,
    scoped,
  };
}

/** The windows a payload carries, in the popover's order: 5-hour, weekly, then scoped caps. */
export function planRows(
  usage: PlanUsageInfo,
  plan: PlanInfo | null,
  nowSec: number,
): PlanWidgetRow[] {
  const rows: PlanWidgetRow[] = [];
  if (usage.five_hour) {
    rows.push(
      row(
        "five_hour",
        accountWindowLabel("five_hour", "long"),
        usage.five_hour,
        plan?.limitType === "five_hour" ? plan.resetsAt : null,
        false,
        nowSec,
      ),
    );
  }
  if (usage.seven_day) {
    rows.push(
      row(
        "seven_day",
        accountWindowLabel("seven_day", "long"),
        usage.seven_day,
        plan?.limitType === "seven_day" ? plan.resetsAt : null,
        false,
        nowSec,
      ),
    );
  }
  // Scoped caps take no fallback: the coarse reset belongs to an account-wide window.
  // Keyed by what names them (label + group), so a cap keeps its bar — and its width
  // transition — when the list reorders; a repeat of the same pair gets an occurrence suffix
  // rather than a duplicate React key.
  const seen = new Map<string, number>();
  for (const s of usage.scoped ?? []) {
    const base = `scoped:${s.label}:${s.group ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    rows.push(
      row(n ? `${base}#${n}` : base, scopedUsageLabel(s, "long"), s.window, null, true, nowSec),
    );
  }
  return rows;
}

/** The coarse-status lines (Claude only). « Near limit » is left to the bars when they exist —
 *  an amber bar already says it.
 *
 *  ⚠️ The status is STICKY: the store keeps the last `rate_limit_event` until the CLI sends
 *  another, which only happens on a turn. So once the reset it announced has PASSED, « Limit
 *  reached » describes a window that is over — it is dropped then (the minute tick runs until
 *  that moment, `hasFutureReset`), never left standing for hours. A status with no reset at all
 *  is kept: nothing says it has lifted. */
function planNotices(plan: PlanInfo | null, haveBars: boolean, nowSec: number): PlanWidgetNotice[] {
  if (!plan) return [];
  const out: PlanWidgetNotice[] = [];
  const lapsed = !!plan.resetsAt && plan.resetsAt <= nowSec;
  const resetSec = plan.resetsAt && !lapsed ? plan.resetsAt : null;
  const resetText = resetSec === null ? null : `resets ${fmtReset(resetSec, nowSec)}`;
  if (!lapsed && plan.status === "rejected") {
    out.push({ tone: "err", text: "Limit reached", resetSec, resetText });
  } else if (!lapsed && plan.status === "allowed_warning" && !haveBars) {
    out.push({ tone: "warn", text: "Near the plan's limit", resetSec, resetText });
  }
  if (plan.usingOverage) {
    out.push({ tone: "lo", text: "Overage active", resetSec: null, resetText: null });
  }
  return out;
}

/**
 * The widget's whole verdict, from what the hook read and the time.
 *
 * Priority: a remote conversation first (whatever the local cache holds is ANOTHER account's), then
 * whatever figures exist, then why there are none.
 */
export function planWidgetState(input: PlanWidgetInput, nowMs: number): PlanWidgetView {
  const nowSec = Math.floor(nowMs / 1000);
  const updatedAt = input.updatedAt || null;
  const updatedText = fmtAgo(updatedAt, nowMs);
  const none: PlanWidgetView = {
    body: { kind: "remote" },
    peak: null,
    peakLevel: "ok",
    peakStale: false,
    notices: [],
    updatedAt: null,
    updatedText: null,
    hasFutureReset: false,
    needsClock: false,
  };
  if (input.remote) return none;

  const codex = input.backend === "codex";
  // Codex has no error channel and no coarse status: both are Claude-only by construction.
  const error = codex ? null : input.error;
  const plan = codex ? null : (input.plan ?? null);

  if (!input.usage) {
    const body: PlanWidgetBody = codex
      ? { kind: "codex-waiting" }
      : error
        ? { kind: "error", error }
        : { kind: "unloaded" };
    const notices = planNotices(plan, false, nowSec);
    const hasFutureReset = notices.some((n) => n.resetSec !== null);
    return {
      ...none,
      body,
      notices,
      updatedAt,
      updatedText,
      hasFutureReset,
      needsClock: hasFutureReset || updatedText !== null,
    };
  }

  const rows = planRows(input.usage, plan, nowSec);
  const notices = planNotices(plan, rows.length > 0, nowSec);
  const hasFutureReset =
    rows.some((r) => r.resetSec !== null && !r.past) || notices.some((n) => n.resetSec !== null);
  const needsClock = hasFutureReset || updatedText !== null;
  if (rows.length === 0) {
    return {
      ...none,
      body: error ? { kind: "error", error } : { kind: "none-reported" },
      notices,
      updatedAt,
      updatedText,
      hasFutureReset,
      needsClock,
    };
  }

  // A window past its reset is no longer a reading of NOW: it stays out of the header.
  const live = (key: "five_hour" | "seven_day") => {
    const r = rows.find((x) => x.key === key);
    return r && !r.past ? input.usage![key] : null;
  };
  const rawPeak = peakUsagePercent({ five_hour: live("five_hour"), seven_day: live("seven_day") });
  const peak = rawPeak === null ? null : displayPercent(rawPeak);
  return {
    body: { kind: "bars", rows, staleError: error },
    peak,
    peakLevel: peak === null ? "ok" : usageLevel(peak),
    peakStale: peak !== null && !!error,
    notices,
    updatedAt,
    updatedText,
    hasFutureReset,
    needsClock,
  };
}
