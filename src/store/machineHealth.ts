// Is a paired server REACHABLE right now — the one fact the remote mark paints, and
// the only thing in the app that knows it.
//
// The check itself is not new: `machine_diagnose` has always existed, it is what
// Settings → Control → Remote servers runs to draw each card's headline. What was
// missing is that it only ever ran WHILE that panel was open, so the rest of the app
// learned a server had gone down the hard way — a spawn that fails, a title push that
// quietly `console.warn`s — after the user had already typed a message to an agent that
// was never going to answer. This slice runs the SAME command ambiently and keeps its
// last verdict where every surface can read it.
//
// Deliberate shape:
//  - BINARY (reachable / not), per Alexandre. `ServerDiagnosis` carries far more
//    granularity — `flightdeckd` stopped, `claude` signed out, not reboot-safe — but
//    those are repairs you make in the server panel, not a state a 13px glyph in the
//    sidebar can say anything useful about. The mark answers "can I talk to this
//    machine?"; the panel answers "and what exactly is wrong with it?".
//  - UNKNOWN IS A STATE, and it is the quiet one. A machine with no verdict yet renders
//    exactly as before. We never guess: no verdict is not a verdict.
//  - DEGRADE-ONLY FROM EVIDENCE. "Unreachable" is only ever set by a diagnosis that
//    actually failed to reach the server (`ServerDiagnosis.reachable === false`) — never
//    inferred from a `DiagnosisState::Failed`, which a perfectly reachable server with a
//    stopped daemon also produces. Same prudence as the remote-control bridge's
//    `bridge_state`, which likewise only ever degrades.
//  - NO SETTING. Not seeing that a server is down is a defect, not an experience anyone
//    would choose; the project's reversibility principle covers real features, not
//    fixes. Same reasoning the remote mark itself already carries.
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import { commands, type ServerDiagnosis } from "../ipc/client";

/** What we know about one machine's reachability. Absent from the store = UNKNOWN. */
export interface MachineHealth {
  /** The last verdict an actual round trip produced. */
  reachable: boolean;
  /** When that verdict was observed. */
  checkedAtMs: number;
  /** The last moment we KNOW we reached this machine — carried forward across an
   *  unreachable verdict, so the tooltip can say how long it has been gone instead of
   *  just "down". `null` while it has never answered in this app run. */
  lastReachedAtMs: number | null;
  /** The diagnosis's own wording for why, VERBATIM, when unreachable. Never reworded
   *  here: it is shown to the user, not matched on. `null` when reachable. */
  reason: string | null;
  /** Set when the probe COMMAND itself failed (the machine row was deleted mid-flight,
   *  IPC error) — which is "we could not ask", NOT "the server is down". It never
   *  changes `reachable`; it exists so a machine stuck at UNKNOWN can say why rather
   *  than look like nobody ever tried. Cleared by the next probe that does complete. */
  probeError: string | null;
}

/** Fold a fresh diagnosis into what we already knew. Pure — exported for the test.
 *
 *  ⚠️ Reads `d.reachable` and nothing else. The temptation is to look at `d.state`,
 *  which is right there and reads like a health summary — but `Failed` covers "ssh
 *  worked, `flightdeckd` is stopped", a server that is up and one repair click away.
 *  Painting that machine as unreachable would send the user looking for a network
 *  problem that isn't there. See `ServerDiagnosis::reachable`'s own doc in Rust. */
export function healthFromDiagnosis(
  prev: MachineHealth | undefined,
  d: ServerDiagnosis,
  nowMs: number,
): MachineHealth {
  return {
    reachable: d.reachable,
    checkedAtMs: nowMs,
    lastReachedAtMs: d.reachable ? nowMs : (prev?.lastReachedAtMs ?? null),
    reason: d.reachable ? null : reasonOf(d),
    probeError: null,
  };
}

/** The user-facing "why" for an unreachable machine. `DiagnosisState::Failed`'s reason
 *  is the only place the backend writes one; anything else (which `reachable === false`
 *  should never produce) degrades to nothing rather than to an invented explanation. */
function reasonOf(d: ServerDiagnosis): string | null {
  return d.state.kind === "failed" ? d.state.reason : null;
}

interface MachineHealthState {
  byMachine: Record<string, MachineHealth>;
  /** Record a diagnosis — from the ambient poll, from the Settings server card, from
   *  anywhere that already paid for one. Every producer funnels through here so the
   *  badge can never disagree with the panel.
   *
   *  `startedAtMs` is when THIS probe was fired, and it is what orders two answers that
   *  are in flight at once (see `isStaleProbe`). Omit it only where no newer probe can
   *  possibly exist. */
  record: (machineId: string, diagnosis: ServerDiagnosis, startedAtMs?: number) => void;
  /** A probe that never produced a verdict. Keeps whatever we already knew. */
  recordProbeError: (machineId: string, error: string, startedAtMs?: number) => void;
  /** Drop a machine's row — it was unpaired. */
  forget: (machineId: string) => void;
}

/** When the probe whose answer we ACCEPTED for each machine was fired. */
const appliedProbeStartMs = new Map<string, number>();

/** Is this answer older than one we already applied?
 *
 *  ⚠️ Two probes of the same machine overlap routinely — the panel diagnoses on mount
 *  (bounded at 20s against a dead server) while the user clicks Retry two seconds later
 *  and gets an answer in five. Whoever lands LAST used to win, so the slow "unreachable"
 *  landed on top of the fresh "ready" and re-reddened three surfaces — undoing the very
 *  re-check the user had just asked for. Order by when each probe was FIRED, not by when
 *  it came back.
 *
 *  A caller that passes no `startedAtMs` is treated as current: an answer with no
 *  provenance is never silently dropped. */
function isStaleProbe(machineId: string, startedAtMs: number | undefined): boolean {
  if (startedAtMs === undefined) return false;
  const applied = appliedProbeStartMs.get(machineId);
  return applied !== undefined && startedAtMs < applied;
}

export const useMachineHealthStore = create<MachineHealthState>((set) => ({
  byMachine: {},
  record: (machineId, diagnosis, startedAtMs) => {
    if (isStaleProbe(machineId, startedAtMs)) return;
    appliedProbeStartMs.set(machineId, startedAtMs ?? Date.now());
    // Any recorded verdict counts as "just probed", whoever paid for it — the Settings
    // server card calls `machine_diagnose` itself (it needs the full diagnosis back, which
    // `probeMachine` does not hand over). Without this the ambient poll would dial the
    // same server again seconds after the user hit Refresh.
    lastProbeAtMs.set(machineId, Date.now());
    set((s) => ({
      byMachine: {
        ...s.byMachine,
        [machineId]: healthFromDiagnosis(s.byMachine[machineId], diagnosis, Date.now()),
      },
    }));
  },
  recordProbeError: (machineId, error, startedAtMs) =>
    set((s) => {
      // Same ordering rule as a verdict: a stale "we could not ask" must not land on top
      // of a fresher answer that did get through.
      if (isStaleProbe(machineId, startedAtMs)) return s;
      const prev = s.byMachine[machineId];
      return {
        byMachine: {
          ...s.byMachine,
          [machineId]: prev
            ? { ...prev, probeError: error }
            : {
                // No verdict either way — deliberately NOT `reachable: false`. We failed
                // to ask; the machine is not accused of anything.
                reachable: true,
                checkedAtMs: 0,
                lastReachedAtMs: null,
                reason: null,
                probeError: error,
              },
        },
      };
    }),
  forget: (machineId) =>
    set((s) => {
      if (!(machineId in s.byMachine)) return s;
      const next = { ...s.byMachine };
      delete next[machineId];
      return { byMachine: next };
    }),
}));

/** `undefined` while nothing is known about this machine (or it is a local repo). */
export const useMachineHealth = (machineId: string | null | undefined): MachineHealth | undefined =>
  useMachineHealthStore((s) => (machineId ? s.byMachine[machineId] : undefined));

/** Every machine currently known to be out of reach. Stable identity while the set does
 *  not change, so a subscriber does not re-render on every probe that confirms health. */
export const useUnreachableMachineIds = (): string[] =>
  useMachineHealthStore(
    useShallow((s) =>
      Object.entries(s.byMachine)
        .filter(([, h]) => h.checkedAtMs > 0 && !h.reachable)
        .map(([id]) => id),
    ),
  );

/** True only for a machine we have actually checked and found out of reach. A machine
 *  we have never reached a verdict on is NOT unreachable — it is unknown. */
export const isUnreachable = (h: MachineHealth | undefined): boolean =>
  h !== undefined && h.checkedAtMs > 0 && !h.reachable;

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** Machines with a probe in flight — a burst of triggers (several conversations on the
 *  same dead server failing at once) must cost ONE ssh round trip, not one each. */
const inFlight = new Set<string>();
/** When each machine was last probed, so a trigger that lands right after a scheduled
 *  poll does not immediately pay for a second one. */
const lastProbeAtMs = new Map<string, number>();

/** The shortest gap between two probes of the SAME machine, however many triggers
 *  arrive. `diagnose` is one ssh round trip bounded at 20s; a dead server costs the
 *  full wait, so a tight retry loop would be the worst possible behaviour exactly when
 *  things are already going wrong. */
export const PROBE_MIN_GAP_MS = 15_000;

/**
 * Ask a machine whether it is there, and file the answer.
 *
 * Deduped and rate-limited (see above). `force` skips the rate limit — for an explicit
 * human gesture ("Diagnose"), never for an automatic trigger.
 *
 * Never throws and never rejects: it is called from event handlers and intervals that
 * have nowhere to report to. An outright command failure is filed as `probeError`
 * rather than dropped, so a machine that stays UNKNOWN can explain itself.
 */
export async function probeMachine(machineId: string, force = false): Promise<void> {
  if (inFlight.has(machineId)) return;
  const last = lastProbeAtMs.get(machineId) ?? 0;
  if (!force && Date.now() - last < PROBE_MIN_GAP_MS) return;
  inFlight.add(machineId);
  const startedAtMs = Date.now();
  lastProbeAtMs.set(machineId, startedAtMs);
  try {
    const res = await commands.machineDiagnose(machineId);
    if (res.status === "ok") useMachineHealthStore.getState().record(machineId, res.data, startedAtMs);
    else useMachineHealthStore.getState().recordProbeError(machineId, res.error, startedAtMs);
  } catch (e) {
    useMachineHealthStore
      .getState()
      .recordProbeError(machineId, e instanceof Error ? e.message : String(e), startedAtMs);
  } finally {
    inFlight.delete(machineId);
  }
}

/** Test seam — the module-level dedup state is deliberately not in the store (it is
 *  scheduling, not UI state), so a test needs a way to start clean. */
export function resetProbeStateForTests(): void {
  inFlight.clear();
  lastProbeAtMs.clear();
  appliedProbeStartMs.clear();
}
