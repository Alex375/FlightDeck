// What the second line of a sidebar conversation row shows: the working dots plus a
// counter that either RUNS or is FROZEN, or nothing at all.
//
//  - `live`   — the agent is working: the dots bounce and the counter ticks from `startedAt`
//               (a turn in flight, or background work still running after the turn).
//  - `paused` — the conversation stopped on a state that wants the user (review / error /
//               question) or is blocked on them (permission / questionnaire): the dots go
//               still and the counter freezes on `elapsedMs` — "it ran this long, then
//               stopped here".
//  - `none`   — the two calm states (idle / off): the row is a single line again.
//
// Pure so the rules are locked in a test, and so the row component only renders.

import type { AgentStatus } from "./status";

/** The timing the store keeps for a conversation (see `SessionEntry`). */
export interface RowClock {
  /** Start of the turn in flight, `null` when none is. */
  turnStartedAt: number | null;
  /** Start of the last turn, kept after it ends. */
  lastTurnStartedAt: number | null;
  /** End of the last turn, `null` while one runs. */
  lastTurnEndedAt: number | null;
  /** When the agent blocked on the user, `null` when it isn't. */
  awaitingSince: number | null;
  /** When the background work still running started (earliest running task), `null` when
   *  none is. Outlives the turn that launched it — and any turn run meanwhile. */
  backgroundSince: number | null;
}

export type RowTiming =
  | { mode: "none" }
  /** Working: the counter ticks from `startedAt`. */
  | { mode: "live"; startedAt: number }
  /** Stopped on a state: still dots, and the frozen time — `null` when it is unknown
   *  (nothing was measured live, e.g. a conversation restored from disk), so the row keeps
   *  the same SHAPE in a given state instead of losing its second line. */
  | { mode: "paused"; elapsedMs: number | null };

const NONE: RowTiming = { mode: "none" };
const PAUSED_UNKNOWN: RowTiming = { mode: "paused", elapsedMs: null };

/** Freeze on a span when both ends are known and the span is sane; otherwise freeze with no
 *  time rather than dropping the line. */
function frozen(from: number | null, to: number | null): RowTiming {
  if (from == null || to == null || to < from) return PAUSED_UNKNOWN;
  return { mode: "paused", elapsedMs: to - from };
}

/**
 * The second line's timing for a conversation in `status`, given the clock its session
 * entry carries. A conversation restored from disk has no clock (nothing is measured
 * before the app runs), so a loud state still shows its still dots — just no time — rather
 * than switching shape; only the two calm states drop the line entirely.
 */
export function rowTiming(status: AgentStatus, clock: RowClock | undefined): RowTiming {
  if (!clock) return status.kind === "idle" || status.kind === "off" ? NONE : PAUSED_UNKNOWN;
  switch (status.kind) {
    // Working: the turn itself, or the background work that outlived it — which counts from
    // the WORK's own start, not from a turn (a follow-up turn would restart that clock while
    // the same work keeps running); the turn's start is only a fallback.
    case "running":
      return clock.turnStartedAt == null ? NONE : { mode: "live", startedAt: clock.turnStartedAt };
    case "backgrounding": {
      const since = clock.backgroundSince ?? clock.lastTurnStartedAt;
      return since == null ? NONE : { mode: "live", startedAt: since };
    }
    // Blocked ON the user: nothing is happening, so freeze at the moment the agent asked.
    // The turn is usually still in flight — but a DETACHED sub-agent can ask after its turn
    // ended (`turnStartedAt` cleared), hence the fallback to that turn's start.
    case "needIntervention":
      return frozen(clock.turnStartedAt ?? clock.lastTurnStartedAt, clock.awaitingSince);
    case "needInput":
      return status.via === "questionnaire"
        ? frozen(clock.turnStartedAt ?? clock.lastTurnStartedAt, clock.awaitingSince)
        : frozen(clock.lastTurnStartedAt, clock.lastTurnEndedAt);
    // Settled on a state the user has yet to clear: how long the turn took.
    case "error":
    case "review":
      return frozen(clock.lastTurnStartedAt, clock.lastTurnEndedAt);
    // Calm: no second line. Listed explicitly so a new status kind is a compile error
    // here until it is classified — same discipline as the other classifiers.
    case "idle":
    case "off":
      return NONE;
  }
}
