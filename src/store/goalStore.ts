// Active `/goal` per conversation. `/goal <condition>` is Claude Code's native goal feature:
// Claude keeps working across turns until a small fast model confirms the condition holds, then
// auto-clears. We only DISPLAY it — a target icon on the Flight Deck card and a chip (+ clear
// button) in the composer bar — so the user can see whether a conversation is driving toward a goal.
//
// Read from the transcript, NOT the live stream: the CLI records goal state as
// `attachment` lines of `type:"goal_status"` that are DISK-ONLY (never emitted on stdout), so
// there is nothing to intercept live. The transcript is wherever the conversation RUNS: the read
// is routed by conversation id — this Mac's disk, or the conversation's server (one ssh round
// trip; the server pre-filters the goal lines so the transcript never travels). We fetch it from
// the Rust `load_session_goal`, which scans
// the WHOLE transcript forward — NOT a tail read: a goal set early and never terminated is still
// active at the end of the file, so no suffix would do (a raw-substring pre-filter keeps that
// affordable; see `history.rs::load_active_goal`). Called at conversation load/reload, once per
// Flight Deck card, and on turn edges — but ONLY for conversations that have (or recently had) a
// goal (`goalSeen`), so a fleet of goalless conversations never pays a per-turn transcript read. Kept in memory, keyed by the STABLE
// conversation id; the transcript is its durable source of truth, so nothing to persist. Unlike
// Remote Control, a goal SURVIVES session end (the CLI restores it on `--resume`), so its state is
// only forgotten when the conversation itself is removed (stop/remove/removeRepo/wipe).

import { create } from "zustand";
import { commands } from "../ipc/client";
import type { GoalState } from "../ipc/client";
import { fileReadErrorText } from "../features/conversation/remoteRead";

// Conversations that have, or recently had, an active goal. Only these pay a transcript refetch on
// turn edges (see useGlobalSessionEvents) — a conversation that never used `/goal` reads nothing
// per turn. Seeded by any non-null read, by the load-time seed, and by issuing a `/goal` command.
const goalSeen = new Set<string>();
// Clear lifecycle (composer chip's clear button). `/goal clear` is a LOCAL command whose transcript
// write lands asynchronously — and worse, `useClearGoal` may cold-spawn a `--resume` process first
// (several seconds). So the guard is driven by the mutation lifecycle, NOT a wall-clock from the
// click: `clearingInFlight` freezes the optimistic null while the send is in flight (no flicker
// however long the spawn takes), then a short post-send `clearGraceUntil` window covers the write
// landing. On failure the guard is released and the true (still-active) goal is refetched.
const clearingInFlight = new Set<string>();
const clearGraceUntil = new Map<string, number>();
/** Post-send grace: how long after `/goal clear` is accepted we still ignore a "still active" read
 *  (the transcript write can lag the send). */
const CLEAR_GRACE_MS = 2500;
// Sequence of the LATEST read started per conversation. Three callers race on the same slice (a
// Flight Deck card seeding, a history load/reload, the per-turn busy edge) and NOTHING sequences
// their IPC responses, so a slow older read can land AFTER a newer one and overwrite fresh state
// with stale (e.g. resurrecting a goal the newer read just saw cleared). Stamped at call start and
// re-checked before every write — same convention as `lastMessageSummary.currentSeq`. Module-level
// and non-reactive: it gates writes, it is never rendered.
const currentSeq = new Map<string, number>();
// Bounded post-send refresh ladder (delays in ms). `/goal` is a LOCAL command: it may complete
// without ever producing a model turn, so the busy edge that normally refetches the goal may NEVER
// fire — and both the thread bubble and the CLI stdout are suppressed, so without this the user
// gets literally zero feedback until their next message. One immediate read isn't enough either:
// the `goal_status` transcript write lands asynchronously, and a brand-new conversation has no
// session id until `system/init` arrives. Hence a few widening attempts that stop as soon as the
// value actually moves — never a poll loop (perf: a goalless fleet must pay nothing).
const REFRESH_LADDER_MS = [200, 800, 2000, 4000];
/** In-flight refresh ladder per conversation: at most one, so a new schedule supersedes the old and
 *  teardown can cancel it (a leaked `setTimeout` would fire a read for a removed conversation). */
interface RefreshLadder {
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
}
const refreshLadders = new Map<string, RefreshLadder>();

interface GoalStore {
  /** convId → active goal, or `null` when no goal is active. Absent = not yet fetched. */
  byConv: Record<string, GoalState | null>;
  set: (convId: string, goal: GoalState | null) => void;
  clear: (convId: string) => void;
  /** Drop every conversation's goal (wipe-all). */
  clearAll: () => void;
}

export const useGoalStore = create<GoalStore>((set) => ({
  byConv: {},
  set: (convId, goal) =>
    set((s) => {
      // Short-circuit a genuine no-op (the turn-edge refetch runs every turn) so subscribers don't
      // re-render. Guarded on the KEY already existing: a first fetch that returns `null` (no goal)
      // must still RECORD the key, so `seedActiveGoalOnce` knows this conversation has been read.
      if (convId in s.byConv && sameGoal(s.byConv[convId], goal)) return s;
      return { byConv: { ...s.byConv, [convId]: goal } };
    }),
  clear: (convId) => {
    // Prune every per-conversation goal slice on the same removal paths as the rest of the app.
    goalSeen.delete(convId);
    clearingInFlight.delete(convId);
    clearGraceUntil.delete(convId);
    // Dropping the seq also invalidates any read still in flight for this conversation: its
    // stamp no longer matches, so it can't resurrect the key we're about to delete.
    currentSeq.delete(convId);
    cancelGoalRefresh(convId);
    set((s) => {
      if (!(convId in s.byConv)) return s;
      const next = { ...s.byConv };
      delete next[convId];
      return { byConv: next };
    });
  },
  clearAll: () => {
    goalSeen.clear();
    clearingInFlight.clear();
    clearGraceUntil.clear();
    currentSeq.clear();
    for (const convId of [...refreshLadders.keys()]) cancelGoalRefresh(convId);
    set({ byConv: {} });
  },
}));

function sameGoal(a: GoalState | null, b: GoalState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.condition === b.condition && (a.reason ?? null) === (b.reason ?? null);
}

/** Does this composer text invoke the `/goal` local command (set / clear / status)? Used to (a) mark
 *  the conversation `goalSeen` so the next turn edge picks up a freshly set goal, and (b) send it
 *  silently — goal plumbing is represented by the chip, never as a thread bubble. Word-bounded so a
 *  message that merely mentions `/goal` in prose does not match. */
export function isGoalCommand(text: string): boolean {
  return /^\/goal(\s|$)/.test(text.trimStart());
}

/** Mark a conversation as having a goal to track, so its turn edges refetch (see the `goalSeen`
 *  gate). Called when the user issues a `/goal` command — the goal_status lands on disk a moment
 *  later, so the gate must be armed before the next turn edge, not by the read itself. */
export function markGoalSeen(convId: string): void {
  goalSeen.add(convId);
}

/** Whether a conversation is worth a per-turn goal refetch (it has, or recently had, a goal). */
export function hasSeenGoal(convId: string): boolean {
  return goalSeen.has(convId);
}

/** Arm the clear guard: freeze the optimistic null while `/goal clear` is in flight (however long a
 *  cold `--resume` spawn takes). Call at click, before any async. */
export function beginGoalClearing(convId: string): void {
  clearingInFlight.add(convId);
}

/** The clear send was accepted: switch from "in flight" to a short grace window while the transcript
 *  write lands, then normal refetches resume. */
export function settleGoalClearing(convId: string): void {
  clearingInFlight.delete(convId);
  clearGraceUntil.set(convId, Date.now() + CLEAR_GRACE_MS);
}

/** The clear send FAILED: release the guard entirely so the caller's rollback refetch can restore
 *  the still-active goal (never leave the chip wrongly hidden over a live goal). */
export function endGoalClearing(convId: string): void {
  clearingInFlight.delete(convId);
  clearGraceUntil.delete(convId);
}

/**
 * Refresh a conversation's active goal from its transcript — on this Mac, or on the paired
 * server the conversation runs on (the read is routed by `convId`). `sessionId` is the CLI
 * session id (the transcript key); a conversation that never sent a message has none → no goal.
 * A read failure is non-fatal (the next turn-edge refetch corrects it) and leaves the last known
 * value untouched. Codex conversations have no Claude transcript, so callers gate this off for them.
 * Concurrency-safe: several callers race, so each call stamps a per-conversation sequence and a
 * response is DROPPED if a newer call started meanwhile (never overwrite fresh state with stale).
 */
export async function refreshActiveGoal(convId: string, sessionId: string | null | undefined): Promise<void> {
  const seq = (currentSeq.get(convId) ?? 0) + 1;
  currentSeq.set(convId, seq);
  if (!sessionId) {
    if (clearingInFlight.has(convId)) return; // a clear is racing — don't clobber it
    // Same rule as the empty read below: while a ladder is pending, "no session id yet" is a
    // transient, not a verdict, so it must not disarm the gate the composer just armed.
    if (!refreshLadders.has(convId)) goalSeen.delete(convId);
    useGoalStore.getState().set(convId, null);
    return;
  }
  // Routed by the conversation: this Mac's transcript, or its server's.
  const res = await commands.loadSessionGoal(convId, sessionId);
  if (res.status !== "ok") {
    // Non-fatal (the next turn-edge refetch corrects it) and the last known value stays — but
    // never silent: say where it failed (an unreachable server is named).
    console.error("loadSessionGoal failed:", fileReadErrorText(res.error));
    return;
  }
  // Stale response: a newer refresh started while this read was in flight (or the conversation was
  // removed, dropping the seq). The newer answer is the truthful one, so drop this whole response
  // — including its goalSeen / grace bookkeeping — instead of writing yesterday's transcript state.
  if (currentSeq.get(convId) !== seq) return;
  // A clear is still in flight (send not yet accepted): keep the optimistic null, ignore any read.
  if (clearingInFlight.has(convId)) return;
  const grace = clearGraceUntil.get(convId);
  if (grace !== undefined && Date.now() < grace) {
    // Post-send grace: accept a confirmed null (the clear landed → done), but ignore a still-active
    // read (the transcript write hasn't caught up) so the chip doesn't flicker back on.
    if (res.data == null) {
      clearGraceUntil.delete(convId);
      goalSeen.delete(convId);
      useGoalStore.getState().set(convId, null);
    }
    return;
  }
  clearGraceUntil.delete(convId);
  if (res.data != null) goalSeen.add(convId);
  // A refresh ladder is pending ⇒ a `/goal` send is still landing, so an empty read means "the
  // transcript write hasn't caught up", NOT "no goal" — the same call the ladder's missing-session-id
  // rung already makes, applied to the read itself. Disarming here would strip the gate the composer
  // armed on the send, and that gate is what makes the per-turn refetch (see `hasSeenGoal` in
  // useGlobalSessionEvents) the fallback the ladder hands over to when it runs out of rungs: a goal
  // that lands late would then stay invisible on BOTH surfaces for the rest of the run, with nothing
  // left to correct it. A genuinely goalless conversation is disarmed by the next ladder-free read,
  // so the "goalless fleets read nothing per turn" perf gate self-heals within one turn.
  else if (!refreshLadders.has(convId)) goalSeen.delete(convId);
  useGoalStore.getState().set(convId, res.data);
}

/** Cancel a conversation's pending refresh ladder, if any. Marks it cancelled as well as clearing
 *  the timer, because a rung may be awaiting its IPC read right now — its continuation must not
 *  re-arm the next rung after teardown. */
function cancelGoalRefresh(convId: string): void {
  const ladder = refreshLadders.get(convId);
  if (!ladder) return;
  ladder.cancelled = true;
  if (ladder.timer !== null) clearTimeout(ladder.timer);
  refreshLadders.delete(convId);
}

/**
 * Refresh a conversation's goal shortly after a `/goal` command was sent, on a short bounded
 * ladder (see `REFRESH_LADDER_MS`). Without it a `/goal <condition>` gives NO feedback at all: the
 * bubble is suppressed, the CLI's stdout is suppressed, and being a local command it may never
 * produce the model turn whose busy edge normally refetches the goal.
 *
 * Stops as soon as the stored value CHANGES relative to the snapshot taken here — which covers both
 * directions (a goal appearing after `/goal <condition>`, and a goal disappearing after
 * `/goal clear`) — otherwise runs out of rungs and gives up. Only one ladder per conversation: a
 * new schedule supersedes the previous one, and `clear`/`clearAll` cancel it.
 *
 * `resolveSessionId` is re-invoked on EVERY attempt and supplied by the CALLER: a brand-new
 * conversation has no session id until `system/init` lands, and this module must not import
 * `conversationsStore` (which already imports this one — that would be a circular import).
 */
export function scheduleGoalRefresh(
  convId: string,
  resolveSessionId: () => string | null | undefined,
): void {
  cancelGoalRefresh(convId); // one ladder per conversation: the newest send wins
  // ⚠️ `undefined` (never read) is NOT a value to settle on: to the user it means exactly what
  // `null` (read, no goal) means — nothing shown. Coercing it here is what makes the ladder work on
  // a BRAND-NEW conversation, the very case it exists for: ⌘N then `/goal <condition>` as the first
  // message leaves the slot unseeded (`loadConversationHistory` bails for want of a session id, and
  // no Flight Deck card is mounted to seed it), so the first rung reads before the `goal_status`
  // write lands — and an `undefined → null` slot move would read as "the value changed" and settle
  // the ladder on rung 1, on the exact case it was added for.
  const before = useGoalStore.getState().byConv[convId] ?? null;
  const ladder: RefreshLadder = { timer: null, cancelled: false };
  refreshLadders.set(convId, ladder);

  const settle = () => {
    if (refreshLadders.get(convId) === ladder) refreshLadders.delete(convId);
  };

  const step = (rung: number) => {
    if (ladder.cancelled) return;
    if (rung >= REFRESH_LADDER_MS.length) return settle(); // out of rungs: the turn edge takes over
    ladder.timer = setTimeout(() => {
      ladder.timer = null;
      if (ladder.cancelled) return;
      const sessionId = resolveSessionId();
      if (!sessionId) {
        // No session id YET (the spawn hasn't reported `system/init`). Deliberately do NOT call
        // `refreshActiveGoal` here: it treats a missing session id as an authoritative "no goal"
        // and disarms `goalSeen` — which is exactly the gate the composer just armed for this
        // send. In the ladder, a missing session id means "not yet", not "no goal" → skip the rung.
        step(rung + 1);
        return;
      }
      void refreshActiveGoal(convId, sessionId).then(() => {
        if (ladder.cancelled) return;
        // The value moved (goal appeared, or cleared) → the write landed, nothing left to wait for.
        if (!sameGoal(before, useGoalStore.getState().byConv[convId] ?? null)) return settle();
        step(rung + 1);
      });
    }, REFRESH_LADDER_MS[rung]);
  };

  step(0);
}

/** Seed a conversation's goal from its transcript the FIRST time it's needed this run (a Flight Deck
 *  card mounting), so a goal set in a PRIOR app session shows right after quit/relaunch — the goal
 *  lives on disk but this store is in-memory. No-op once the conversation has been read (its key is
 *  present, even if the value is `null`). Live freshness then comes from the turn-edge refetch and
 *  direct clears; a stopped conversation re-seeds on its next history reload. */
export function seedActiveGoalOnce(convId: string, sessionId: string | null | undefined): void {
  if (convId in useGoalStore.getState().byConv) return;
  void refreshActiveGoal(convId, sessionId);
}

/** Reactive active goal for one conversation (`null` when none / not yet fetched). */
export function useActiveGoal(convId: string | null | undefined): GoalState | null {
  return useGoalStore((s) => (convId ? s.byConv[convId] ?? null : null));
}
