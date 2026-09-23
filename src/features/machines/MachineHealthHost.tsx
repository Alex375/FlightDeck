// The ambient half of machine health: it runs `machine_diagnose` on a slow loop so a
// server that goes down is VISIBLE without anyone opening Settings. Renders nothing.
//
// Everything here is about not paying for this more than it is worth — the project's
// performance principle applies squarely to a recurring network call:
//
//  - ONLY MACHINES IN USE. A paired server with no repository on it is never probed;
//    nothing in the UI would show its state anyway, and it is one Settings click away.
//  - PER MACHINE, NEVER PER REPOSITORY. Five folders on one server are one probe.
//  - PAUSED WHEN THE WINDOW IS HIDDEN. There is no badge to look at, and waking a
//    laptop's network on a timer for an invisible glyph is exactly the cost that makes
//    people turn features off.
//  - PAUSED WHILE SETTINGS IS OPEN. `ServerStatusPanel` diagnoses on mount and on
//    Refresh, and files its result in the SAME store — probing on top of it would
//    double every round trip precisely when the user is already looking at the answer.
//  - STAGGERED. Several machines do not all dial out on the same tick.
//
// The probe itself (dedup, rate limit, error filing) lives in `store/machineHealth.ts`;
// this component only decides WHEN.
import { useEffect } from "react";
import { useMachines, useRepos } from "../../store/conversationsStore";
import { useSettingsUi } from "../../store/settingsUi";
import { probeMachine, useMachineHealthStore } from "../../store/machineHealth";

/** How often a machine in use is re-checked. Generous on purpose: this exists to catch
 *  "the server died while I was working", a thing that happens on the scale of minutes,
 *  not seconds. The instant signals (a spawn that fails, a title push that doesn't
 *  land) trigger their own immediate probe, so this interval is the FLOOR of how fast
 *  we notice, not the whole story. */
const POLL_MS = 90_000;
/** Spacing between successive machines' first probes, so a fleet of servers does not
 *  open N ssh connections in the same millisecond. */
const STAGGER_MS = 700;

export function MachineHealthHost() {
  const machines = useMachines();
  const repos = useRepos();
  const settingsOpen = useSettingsUi((s) => s.open);

  // Drop the row of any machine that is no longer paired, so a stale "unreachable"
  // cannot outlive the server it described (and cannot be re-shown if an id is reused).
  useEffect(() => {
    const paired = new Set(machines.map((m) => m.id));
    const known = Object.keys(useMachineHealthStore.getState().byMachine);
    for (const id of known) if (!paired.has(id)) useMachineHealthStore.getState().forget(id);
  }, [machines]);

  // Which machines are worth asking about: those that are PAIRED and actually host a
  // repository. A repo pointing at a machine that is no longer paired has no connection
  // details left to dial — the mark already says so on its own, and probing it could
  // only ever produce "unknown server". Joined as a sorted, stable string so this effect
  // re-runs when the SET changes, not on every unrelated repo edit.
  const paired = new Set(machines.map((m) => m.id));
  const inUse = [
    ...new Set(repos.map((r) => r.machineId).filter((id): id is string => !!id && paired.has(id))),
  ]
    .sort()
    .join(",");

  useEffect(() => {
    if (!inUse) return;
    if (settingsOpen) return;
    const ids = inUse.split(",");
    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const sweep = () => {
      // `document.hidden` is read at each tick rather than subscribed to: the interval
      // keeps its rhythm, it just does nothing while nobody is looking. Coming back to
      // the window is handled by the visibility listener below, which probes at once
      // instead of making the user wait out the rest of the period.
      if (typeof document !== "undefined" && document.hidden) return;
      ids.forEach((id, i) => {
        timers.push(
          setTimeout(() => {
            if (!disposed) void probeMachine(id);
          }, i * STAGGER_MS),
        );
      });
    };

    sweep();
    const interval = setInterval(sweep, POLL_MS);
    // Returning to the app is the moment a stale verdict matters most — it is exactly
    // when the user is about to type to one of these agents.
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) sweep();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      clearInterval(interval);
      for (const t of timers) clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [inUse, settingsOpen]);

  return null;
}
