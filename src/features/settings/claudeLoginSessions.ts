// Shared-by-machine-id view of "is a Claude sign-in currently live for this server" —
// B-finding #4's second half. `ClaudeSignInInline` mounts independently in two places
// for the SAME freshly-bootstrapped machine (the wizard's own inline step, always
// shown; `ServerStatusPanel`'s own action, shown on click) — before this store existed,
// each one only knew about a session IT had itself started, so the status panel kept
// offering its own "Sign in to Claude" button even while the wizard already had one in
// flight. The backend fix (`start_claude_login` attaches to an existing session rather
// than killing it) makes clicking that second button SAFE, but this store is what lets
// the status panel show "Sign-in in progress…" INSTEAD of ever offering that second
// button in the first place.
//
// A plain module-level flag map, not `localStorage`/anything persisted — this is
// process-lifetime, per-viewer UI state, the same class of thing `termManager`/
// `voice/realtime.ts` keep OUTSIDE React and OUTSIDE any store meant for durable state.
import { create } from "zustand";
import { events } from "../../ipc/client";

interface ClaudeLoginSessionsState {
  /** `machine_id -> true` while ANY surface has a sign-in session live for it (started
   *  via `startClaudeLogin` or `restartClaudeLogin`, not yet resolved/cancelled).
   *  Absent (not just `false`) for a machine nothing has ever touched. */
  active: Record<string, boolean>;
  /** `machine_id -> session_id` of the session currently backing `active` for that
   *  machine — added alongside `ServerLogin*Event.session_id` by a follow-up review of
   *  B-finding #4: without it, the terminal-event listener below can't tell a
   *  session's OWN result apart from a STALE one belonging to a session this machine
   *  has already moved past. Concretely: `restart_claude_login` registers its NEW
   *  session (via `ClaudeSignInInline.restart()` calling `setActive` below) well
   *  before the OLD, just-superseded session's own belated `ServerLoginResultEvent`
   *  can arrive — without this map, that late event would incorrectly flip `active`
   *  back to `false` even though the NEW session is still very much live. Left stale
   *  (never explicitly cleared) once a machine's session ends — harmless, since the
   *  next real session for that machine overwrites it before its own terminal event
   *  could possibly arrive. */
  sessionIds: Record<string, string>;
  /** `sessionId` should always be given when `value` is `true` (there is no such thing
   *  as an active session with no id) — it's optional only because a `false` clear
   *  never needs one, and because tests drive this store directly without one. */
  setActive: (machineId: string, value: boolean, sessionId?: string) => void;
}

export const useClaudeLoginSessions = create<ClaudeLoginSessionsState>((set) => ({
  active: {},
  sessionIds: {},
  setActive: (machineId, value, sessionId) =>
    set((s) => {
      if (s.active[machineId] === value && (sessionId === undefined || s.sessionIds[machineId] === sessionId)) return s;
      return {
        active: { ...s.active, [machineId]: value },
        sessionIds: sessionId !== undefined ? { ...s.sessionIds, [machineId]: sessionId } : s.sessionIds,
      };
    }),
}));

// Wired ONCE regardless of how many `ClaudeSignInInline` instances mount/unmount over
// the app's lifetime — mirrors `termManager`'s "the session lives outside React, only
// its STATE is rendered by components" discipline. A `ServerLoginResultEvent` is the
// ONLY thing that can clear `active` from OUTSIDE the surface that set it (a same-
// caller Cancel clears it locally instead — see `ClaudeSignInInline`'s own cleanup): it
// fires for every terminal outcome that isn't a same-caller cancel (done, failed, AND
// superseded — see `run_login_actor`'s doc), so this never gets stuck true after a
// session it didn't start itself ends.
let wired = false;
export function ensureClaudeLoginSessionsWired(): void {
  if (wired) return;
  wired = true;
  void events.serverLoginPromptEvent.listen((e) => {
    useClaudeLoginSessions.getState().setActive(e.payload.machine_id, true, e.payload.session_id);
  });
  void events.serverLoginResultEvent.listen((e) => {
    const known = useClaudeLoginSessions.getState().sessionIds[e.payload.machine_id];
    // A terminal event for a session this machine has already moved past (the OLD,
    // superseded session's own belated result — see `sessionIds`'s own doc) must NOT
    // clear `active`: the new session is still live. `known === undefined` (nothing
    // ever recorded for this machine, e.g. a test driving this store directly) falls
    // through and clears, matching the pre-existing behavior.
    if (known !== undefined && known !== e.payload.session_id) return;
    useClaudeLoginSessions.getState().setActive(e.payload.machine_id, false);
  });
}
