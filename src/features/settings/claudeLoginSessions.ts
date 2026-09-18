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
  setActive: (machineId: string, value: boolean) => void;
}

export const useClaudeLoginSessions = create<ClaudeLoginSessionsState>((set) => ({
  active: {},
  setActive: (machineId, value) =>
    set((s) => (s.active[machineId] === value ? s : { active: { ...s.active, [machineId]: value } })),
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
    useClaudeLoginSessions.getState().setActive(e.payload.machine_id, true);
  });
  void events.serverLoginResultEvent.listen((e) => {
    useClaudeLoginSessions.getState().setActive(e.payload.machine_id, false);
  });
}
