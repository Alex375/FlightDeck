// A remote link's lifecycle notices — "lost", "reconnected", "trying another address" — folded
// into ONE line per run. A flapping link (a train, a weak Wi-Fi, a laptop the user is not even
// looking at) used to write a pair of lines per drop, dozens of them; what the user needs is to
// know, once, that the link dropped — how often, when, and whether it is back. Pure.
//
// The core tags each lifecycle notice (`remote_link` with `detail.link`, see `run_actor`): a run is
// a stretch of them with nothing else in between. The conversation store folds each new one into
// the run the timeline ends on (`reduceItem`), so the timeline holds one entry whatever the count;
// anything else landing in the thread (a turn, a result, another notice) closes the run, and the
// next drop opens a new one — at its true place in the story.
import type { JsonValue } from "../ipc/client";
import { fmtClock, fmtWait } from "../agent/remoteLink";

/** One lifecycle notice, as the core sends it. */
export interface LinkEvent {
  link: "lost" | "restored" | "address";
  atMs: number | null;
  message: string;
  /** Why this drop happened, when the core knows ("stalled"). */
  cause?: string | null;
  /** A local explanation ("Tailscale looks off on this Mac."). */
  hint?: string | null;
  /** The address an address rotation moved to. */
  address?: string | null;
  /** `false` for a first dial that never attached — nothing was "lost". */
  attachedBefore?: boolean;
}

/** A run of lifecycle notices, folded. */
export interface LinkRun {
  /** How many times the link went down in this run (a stall and its close are one drop). */
  drops: number;
  /** Down at the end of the run (no "restored" since the last drop). */
  down: boolean;
  firstAtMs: number | null;
  /** When the current — or last — drop began. */
  lostAtMs: number | null;
  restoredAtMs: number | null;
  /** The run began on a first dial that never attached. */
  neverAttached: boolean;
  /** The current drop's local explanation, if any. */
  hint: string | null;
  /** Every event, oldest first, for the line's tooltip — the newest {@link MAX_EVENTS} only. */
  events: LinkEvent[];
  /** How many older events were dropped from `events`. */
  trimmed: number;
}

/** A run keeps this many events for its tooltip: enough to read a burst, bounded for a link that
 *  flaps all night. */
export const MAX_EVENTS = 30;

/** The key a folded run is stored under in its notice's `detail`. */
const RUN_KEY = "link_run";

function obj(v: JsonValue | undefined): Record<string, JsonValue> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : null;
}
const str = (v: JsonValue | undefined): string | null => (typeof v === "string" && v ? v : null);
const num = (v: JsonValue | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The lifecycle event a raw notice detail carries, or `null` for any other notice (a takeover, a
 *  message to resend, a restarted server — each stays its own line). */
export function linkEventOf(subtype: string, detail: JsonValue): LinkEvent | null {
  if (subtype !== "remote_link") return null;
  const d = obj(detail);
  const link = d?.link;
  if (link !== "lost" && link !== "restored" && link !== "address") return null;
  return {
    link,
    atMs: num(d?.at_ms),
    message: str(d?.message) ?? "",
    cause: str(d?.cause),
    hint: str(d?.hint),
    address: str(d?.address),
    attachedBefore: d?.attached_before !== false,
  };
}

/** The run a stored notice holds, or `null` when it is not one. */
export function linkRunOf(subtype: string, detail: JsonValue): LinkRun | null {
  if (subtype !== "remote_link") return null;
  const run = obj(obj(detail)?.[RUN_KEY]);
  return run ? (run as unknown as LinkRun) : null;
}

/** Fold `ev` into `run` (`null`: it opens a new run). */
export function foldLinkEvent(run: LinkRun | null, ev: LinkEvent): LinkRun {
  const base: LinkRun = run ?? {
    drops: 0,
    down: ev.link !== "restored",
    firstAtMs: ev.atMs,
    lostAtMs: null,
    restoredAtMs: null,
    neverAttached: ev.link === "lost" && ev.attachedBefore === false,
    hint: null,
    events: [],
    trimmed: 0,
  };
  const next: LinkRun = { ...base, events: [...base.events, ev] };
  if (next.events.length > MAX_EVENTS) {
    next.trimmed += next.events.length - MAX_EVENTS;
    next.events = next.events.slice(-MAX_EVENTS);
  }
  switch (ev.link) {
    case "lost":
      // Already down: the same drop said twice (a stall, then the transport's close).
      if (!run || !run.down || run.drops === 0) {
        next.drops += 1;
        next.lostAtMs = ev.atMs;
        next.hint = ev.hint ?? null;
      } else if (ev.hint) {
        next.hint = ev.hint;
      }
      next.down = true;
      break;
    case "restored":
      next.down = false;
      next.restoredAtMs = ev.atMs;
      next.hint = null;
      break;
    case "address":
      break;
  }
  return next;
}

const at = (ms: number | null): string => (ms === null ? "" : ` at ${fmtClock(ms)}`);

/** The run's one line. Facts only — what happened and when; what the Mac is doing NOW about a
 *  link that is still down is the live line's job (`agent/remoteLink.ts`), not a thread entry's,
 *  which would go stale the moment the session ends. */
export function linkRunText(run: LinkRun): string {
  if (run.drops === 0) {
    // A run opened by something other than a drop (its drop was cut off by another line):
    // the event says itself.
    return run.events[run.events.length - 1]?.message ?? "";
  }
  const hint = run.down && run.hint ? ` ${run.hint}` : "";
  if (run.drops === 1) {
    if (run.neverAttached) {
      if (run.down) return `Couldn't connect to the server${at(run.lostAtMs)}.${hint}`;
      const took =
        run.restoredAtMs !== null && run.lostAtMs !== null ? `, after ${fmtWait(run.restoredAtMs - run.lostAtMs)} of failed attempts` : "";
      return `Connected to the server${at(run.restoredAtMs)}${took}.`;
    }
    if (run.down) return `Connection to the server lost${at(run.lostAtMs)}.${hint}`;
    const back =
      run.restoredAtMs !== null && run.lostAtMs !== null ? ` — back after ${fmtWait(run.restoredAtMs - run.lostAtMs)}` : " — reconnected";
    return `Connection to the server lost${at(run.lostAtMs)}${back}.`;
  }
  const first = run.firstAtMs === null ? null : fmtClock(run.firstAtMs);
  if (run.down) {
    const since = first ? ` since ${first}` : "";
    return `Connection to the server dropped ${run.drops} times${since} — down again${at(run.lostAtMs)}.${hint}`;
  }
  const last = run.restoredAtMs === null ? null : fmtClock(run.restoredAtMs);
  const span = first && last ? (first === last ? ` around ${first}` : ` between ${first} and ${last}`) : "";
  return `Connection to the server dropped ${run.drops} times${span}, and came back each time.`;
}

/** The detail a folded run is stored as: `message` is the run's line (what `NoticeBlock` renders
 *  and `read_conversation` reads), `link` its state at the end, the run itself under `link_run`. */
export function linkRunDetail(run: LinkRun): JsonValue {
  return {
    message: linkRunText(run),
    link: run.down ? "lost" : "restored",
    [RUN_KEY]: run as unknown as JsonValue,
  };
}

/** One tooltip line per event: "10:02:11 — connection lost". */
export function linkEventLines(run: LinkRun): string[] {
  const clock = (ms: number | null) => {
    if (ms === null) return "";
    const d = new Date(ms);
    return `${fmtClock(ms)}:${String(d.getSeconds()).padStart(2, "0")} — `;
  };
  const lines = run.events.map((ev) => {
    switch (ev.link) {
      case "lost": {
        const what = !ev.attachedBefore ? "couldn't connect" : ev.cause === "stalled" ? "connection stalled" : "connection lost";
        return `${clock(ev.atMs)}${what}${ev.hint ? ` (${ev.hint.replace(/\.$/, "")})` : ""}`;
      }
      case "restored":
        return `${clock(ev.atMs)}connected`;
      case "address":
        return `${clock(ev.atMs)}trying another address${ev.address ? `: ${ev.address}` : ""}`;
    }
  });
  return run.trimmed > 0 ? [`… ${run.trimmed} earlier`, ...lines] : lines;
}
