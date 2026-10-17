// What a remote conversation's ssh link is doing RIGHT NOW, in words — the one voice every
// surface uses (the thread's live line, the Flight Deck card, the sidebar row, the side panel's
// Machine and Stream rows), so none of them can describe the same outage differently. Pure.
//
// The core says what it is doing (`RemoteLinkState`, see its Rust doc): an attempt DIALING now
// (`retry_at_ms: null`), or nothing in flight until `retry_at_ms` — minutes away on purpose once
// the outage is long (`slowed`, to spare the battery). The rule this module exists to keep: a
// spinner (`active`) only while something is actually being attempted. A wait says how long.
import type { RemoteLinkState } from "../ipc/client";

/** What the Mac is doing about a link that is down. */
export type RemoteLinkPhase =
  /** An attempt is in flight. */
  | "dialing"
  /** Waiting out a short backoff before the next attempt. */
  | "waiting"
  /** Waiting minutes between attempts, on purpose (a long outage, to spare the battery). */
  | "slowed"
  /** The next attempt is due — or overdue, after the Mac slept through it: it starts any moment
   *  (the front nudges every link that is down when the Mac or the user comes back). */
  | "due"
  /** This Mac has no network at all: nothing can get through until it is back, and the moment it
   *  is, every link that is down retries at once (`MachineHealthHost`'s `online` nudge). */
  | "offline";

export interface RemoteLinkView {
  phase: RemoteLinkPhase;
  /** Whether something is being attempted right now — the only case a spinner is honest. */
  active: boolean;
  /** Whether an immediate retry is worth offering ("Retry now"): nothing is in flight. */
  canRetryNow: boolean;
  /** The situation ("Connection to Target lost") — changes only with the phase. */
  lead: string;
  /** What comes next and when ("retrying in 12 s") — the part that moves with the clock, or
   *  `null` when nothing is pending (a dial in flight). */
  wait: string | null;
  /** The full line: `lead` — `wait`. */
  text: string;
  /** The same two parts for a tight place (a card's activity line, a row's sub-line), where the
   *  server is already named around it. */
  shortLead: string;
  shortWait: string | null;
  /** `shortLead` · `shortWait`. */
  short: string;
  /** One or two words, for a status label ("Reconnecting", "Link lost", "Offline"). */
  word: string;
  /** Re-render period for a live countdown, or `null` when the text does not move with time. */
  tickMs: number | null;
}

/** "12 s" / "4 min" / "1 h 5 min" — how long until something happens. Rounded UP, so a countdown
 *  never reads "0 s" while there is still a wait, nor "in 4 min" for 4 min 40 s. */
export function fmtWait(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  if (secs < 60) return `${secs} s`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "10:02" — this Mac's local wall clock. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function view(v: Omit<RemoteLinkView, "text" | "short">): RemoteLinkView {
  return {
    ...v,
    text: v.wait ? `${v.lead} — ${v.wait}` : v.lead,
    short: v.shortWait ? `${v.shortLead} · ${v.shortWait}` : v.shortLead,
  };
}

/**
 * The view of a link that is down, or `null` when it is not (attached, local, no live session —
 * `link` null — or a session that ended, whose link no longer means anything).
 *
 * `server` names the machine ("Target"), `null` for "the server". `online: false` is this Mac
 * without any network (`navigator.onLine`); it outranks the backoff, which cannot succeed then.
 */
export function remoteLinkView(
  link: RemoteLinkState | null | undefined,
  nowMs: number,
  { server = null, online = true, ended = false }: { server?: string | null; online?: boolean; ended?: boolean } = {},
): RemoteLinkView | null {
  if (!link || ended) return null;
  const name = server?.trim() || "the server";
  const reconnecting = link.kind === "reconnecting";

  if (!online) {
    return view({
      phase: "offline",
      active: false,
      canRetryNow: false,
      lead: "This Mac is offline",
      wait: `it reconnects to ${name} as soon as the network is back`,
      shortLead: "This Mac is offline",
      shortWait: null,
      word: "Offline",
      tickMs: null,
    });
  }

  if (link.retry_at_ms === null) {
    // The drop is counted as the outage's first failed attempt, so a reconnect's dial number IS
    // `attempt`; a first connect's is the one after its failures.
    const dial = reconnecting ? link.attempt : link.attempt + 1;
    const nth = dial > 1 ? ` (attempt ${dial})` : "";
    const verb = reconnecting ? "Reconnecting" : "Connecting";
    return view({
      phase: "dialing",
      active: true,
      canRetryNow: false,
      lead: `${verb} to ${name}…${nth}`,
      wait: null,
      shortLead: `${verb}…${nth}`,
      shortWait: null,
      word: verb,
      tickMs: null,
    });
  }

  const left = link.retry_at_ms - nowMs;
  const lost = reconnecting ? `Connection to ${name} lost` : `Can't reach ${name}`;
  const lostShort = reconnecting ? "Link lost" : "Can't connect";
  const word = reconnecting ? "Link lost" : "Can't connect";
  if (left <= 0) {
    return view({
      phase: "due",
      active: false,
      canRetryNow: true,
      lead: lost,
      wait: "retrying now",
      shortLead: lostShort,
      shortWait: "retrying now",
      word,
      // Due already: the dial's own state replaces this within a beat; tick in case it does not.
      tickMs: 1000,
    });
  }
  if (link.slowed) {
    const since = fmtClock(link.since_ms);
    return view({
      phase: "slowed",
      active: false,
      canRetryNow: true,
      lead: `${reconnecting ? `No connection to ${name}` : `Can't reach ${name}`} since ${since}`,
      wait: `next try in ${fmtWait(left)} (spaced out to save battery)`,
      shortLead: `Unreachable since ${since}`,
      shortWait: `next try in ${fmtWait(left)}`,
      word: "Unreachable",
      // Minutes-long waits: a once-a-second countdown would only burn renders.
      tickMs: left > 120_000 ? 30_000 : 1000,
    });
  }
  return view({
    phase: "waiting",
    active: false,
    canRetryNow: true,
    lead: lost,
    wait: `retrying in ${fmtWait(left)}`,
    shortLead: lostShort,
    shortWait: `retrying in ${fmtWait(left)}`,
    word,
    tickMs: 1000,
  });
}
