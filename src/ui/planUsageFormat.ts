// The words every plan-usage surface uses for a subscription's rate-limit windows: when a window
// resets, how old the figures are, and what a model-scoped cap is called. Shared by the context
// popover (ui/kit — the composer's ring, the Flight Deck card's meter, the panel's Context
// section) and the side panel's Plan usage widget, so « resets in 2h14 » can never read one way
// in the popover and another in the panel.
//
// Pure — no React, no store — so the boundaries (the switch to days at 24 h, a digits-only reset
// read as SECONDS, « never fetched ») are pinned by tests rather than eyeballed in a popover.
// Lifted out of ui/kit.tsx with its behaviour unchanged; the `now` parameters exist for the tests
// and every caller leaves them out.

/** A plan-usage window's label style: the popover's terse « 5h » / « 7d », or the panel's
 *  spelled-out « 5-hour » / « Weekly », which has the room. */
export type UsageLabelStyle = "short" | "long";

/** The current time in Unix epoch SECONDS — the unit every reset is compared in. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Normalize a window's raw `resets_at` to Unix epoch SECONDS for {@link fmtReset}.
 *
 * ⚠️ Two shapes reach here: ISO 8601 from the live Claude endpoint, and a digits-only epoch in
 * SECONDS (Codex's push, which the core normalizes to exactly that form, and the legacy wrapper).
 * A digits-only value is therefore read as seconds — never feed this milliseconds. `null` when
 * absent or unparseable.
 */
export function resetToEpochSeconds(s: string | null): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * « in 3d 4h » (≥ 24 h) / « in 2h14 » / « in 43min » / « imminent » (already passed) / « — »
 * (unknown). The 7-day window resets days away, so above 24 h it reads days + hours (hours only
 * gave « in 73h »); below, hours + minutes.
 *
 * Computed when called: a surface that stays on screen must re-render to keep it true (the side
 * panel's widget runs a minute tick for that; the popover is re-opened fresh each time).
 */
export function fmtReset(resetsAt: number | null, nowSec: number = nowSeconds()): string {
  if (!resetsAt) return "—";
  const secs = resetsAt - nowSec;
  if (secs <= 0) return "imminent";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `in ${d}d ${rh}h` : `in ${d}d`;
  }
  return h > 0 ? `in ${h}h${m.toString().padStart(2, "0")}` : `in ${m}min`;
}

/**
 * « just now » / « 3 min ago » / « 2 h ago » / « 1 d ago » — how long ago the shown figures were
 * last fetched SUCCESSFULLY (or pushed, for Codex). `null` AND `0` both mean « never » and give
 * `null`, so the caller hides the line: TanStack's `dataUpdatedAt` is 0, not null, before the
 * first success.
 */
export function fmtAgo(ts: number | null | undefined, nowMs: number = Date.now()): string | null {
  if (!ts) return null;
  const secs = Math.floor((nowMs - ts) / 1000);
  if (secs < 30) return "just now";
  const m = Math.floor(secs / 60);
  if (m < 1) return "less than 1 min ago";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

/** The label of one of the two ACCOUNT-wide windows. */
export function accountWindowLabel(
  which: "five_hour" | "seven_day",
  style: UsageLabelStyle = "short",
): string {
  if (which === "five_hour") return style === "long" ? "5-hour" : "5h";
  return style === "long" ? "Weekly" : "7d";
}

/**
 * Label a model-scoped cap: its name plus the window it spans — « Fable · 7d » in the popover,
 * « Fable · weekly » in the panel — so it reads in the same idiom as the account-wide rows above
 * it. The suffix comes from the payload's `group` and is dropped when that is absent or unknown:
 * a duration is never guessed.
 */
export function scopedUsageLabel(
  s: { label: string; group: string | null },
  style: UsageLabelStyle = "short",
): string {
  const win =
    s.group === "weekly"
      ? style === "long"
        ? "weekly"
        : "7d"
      : s.group === "session"
        ? style === "long"
          ? "5-hour"
          : "5h"
        : null;
  return win ? `${s.label} · ${win}` : s.label;
}
