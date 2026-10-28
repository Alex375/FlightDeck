// Each paired server's ALIGNMENT on this Mac (CRM 763ae7f2): is its `claude`, its
// `flightdeckd` and its `~/.claude` config this Mac's? The work lives in Rust
// (`bootstrap::align`); this slice keeps what it last reported, for the server panel and
// the model picker, and fires the automatic pass at the one moment the front sees first —
// a server coming back within reach.
//
//  - The pass itself decides whether it is due (the server's "Keep aligned" toggle, and a
//    pass that already found everything in line a few minutes ago for an unchanged Mac):
//    asking costs no ssh round trip when it is not.
//  - Every producer funnels through `applyState` — the Rust event, a direct call's answer —
//    so the panel and the picker never disagree.
import { create } from "zustand";
import { commands, events, type AlignReport, type MachineAlignState } from "../ipc/client";
import { useMachineHealthStore, type MachineHealth } from "./machineHealth";

interface ServerAlignState {
  byMachine: Record<string, MachineAlignState>;
  applyState: (state: MachineAlignState) => void;
  forget: (machineId: string) => void;
}

export const useServerAlignStore = create<ServerAlignState>((set) => ({
  byMachine: {},
  applyState: (state) => set((s) => ({ byMachine: { ...s.byMachine, [state.machine_id]: state } })),
  forget: (machineId) =>
    set((s) => {
      if (!(machineId in s.byMachine)) return s;
      const next = { ...s.byMachine };
      delete next[machineId];
      return { byMachine: next };
    }),
}));

/** A server's alignment state, `undefined` until it is loaded. */
export function useMachineAlign(machineId: string | null | undefined): MachineAlignState | undefined {
  return useServerAlignStore((s) => (machineId ? s.byMachine[machineId] : undefined));
}

/** The `claude` version a server runs, as its last alignment pass read it — `null` when no
 *  pass has read it in this app run. What the model picker checks a model's floor against. */
export function serverClaudeVersion(state: MachineAlignState | undefined): string | null {
  return state?.last?.server_claude_version ?? null;
}

/** Load a server's state (the panel, on mount). */
export async function loadAlignState(machineId: string): Promise<MachineAlignState> {
  const state = await commands.machineAlignState(machineId);
  useServerAlignStore.getState().applyState(state);
  return state;
}

/** "Sync now": a pass regardless of the toggle. `error` is why it could not even start. */
export async function syncServerNow(machineId: string): Promise<{ report: AlignReport | null; error: string | null }> {
  const res = await commands.alignMachine(machineId);
  if (res.status === "ok") return { report: res.data, error: null };
  return { report: null, error: res.error };
}

/** The server's "Keep this server aligned with this Mac" toggle. */
export async function setKeepAligned(machineId: string, enabled: boolean): Promise<string | null> {
  const res = await commands.setMachineKeepAligned(machineId, enabled);
  if (res.status === "ok") {
    useServerAlignStore.getState().applyState(res.data);
    return null;
  }
  return res.error;
}

/** Pure: did `next` just bring `machineId` back within reach — after no verdict, after one
 *  that said unreachable, or after a probe that never answered (`checkedAtMs` 0, which
 *  is no verdict: see `recordProbeError`)? */
export function reachedAgain(prev: MachineHealth | undefined, next: MachineHealth | undefined): boolean {
  if (!next || !next.reachable || next.checkedAtMs === 0) return false;
  return !prev || !prev.reachable || prev.checkedAtMs === 0;
}

/** Ask for an automatic pass; its outcome arrives as the Rust event. A pass that could not
 *  run is filed by Rust as `last_error` (shown in the panel) — the log line is only for us. */
function alignIfDue(machineId: string): void {
  void commands.alignMachineIfDue(machineId).then((res) => {
    if (res.status === "error") console.warn(`[serverAlign] automatic alignment of ${machineId}: ${res.error}`);
  });
}

/** Wire the slice: the Rust event, and the automatic pass on each server that comes back
 *  within reach (which also covers launch — a server's first verdict — and a remote link
 *  that reconnects: the attached link files its verdict there). Returns the teardown. */
export function startServerAlign(): () => void {
  const un = events.machineAlignEvent.listen((e) => useServerAlignStore.getState().applyState(e.payload.state));
  const unHealth = useMachineHealthStore.subscribe((s, prev) => {
    for (const [id, next] of Object.entries(s.byMachine)) {
      if (reachedAgain(prev.byMachine[id], next)) alignIfDue(id);
    }
  });
  return () => {
    unHealth();
    void un.then((f) => f());
  };
}
