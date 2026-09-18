// Drives the Rust `power` service's keep-awake assertion from a desired boolean. Split out of
// CaffeinateHost so the timing (serialized IPC, re-assert heartbeat, release grace) can be
// tested without mounting the fleet stores that compute `desired`.
import { useEffect, useRef } from "react";
import { commands } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";

/** Slow heartbeat re-asserting the keep-awake hold: if the `caffeinate` child is killed out
 *  from under us while it should stay held, the next tick calls `set_awake(true)` again and the
 *  idempotent Rust `hold()` respawns it. Cheap (a no-op while the child is still alive). */
const REASSERT_MS = 30_000;

// Serialize every `set_awake` IPC so the calls apply in ISSUE ORDER and the last intent wins.
// The heartbeat above can have an in-flight `setAwake(true)` that — without this — could reach
// the Rust mutex AFTER a near-simultaneous release's `setAwake(false)` (Tauri does not guarantee
// cross-invoke ordering) and strand the Mac held awake, with no further heartbeat to self-correct
// while `desired` is false. Chaining makes a later-issued release always win. Same "serialize the
// writes to a shared resource" discipline as the CLI-config writers.
let awakeChain: Promise<unknown> = Promise.resolve();
function setAwakeSerialized(desired: boolean) {
  const call = awakeChain.then(() => commands.setAwake(desired));
  awakeChain = call.catch(() => {}); // keep the chain alive past a rejection
  return call;
}

/**
 * Hold the Mac awake while `desired`, release it otherwise — but a release that follows a hold
 * waits `releaseGraceMs` first, and is cancelled if `desired` comes back within that window (the
 * `caffeinate` child is never killed, so no respawn either). `0` releases at once. The grace is
 * read when the release starts: dropping it to `0` mid-window releases immediately.
 *
 * WebKit may throttle the grace timer while the window is hidden; that only lengthens the
 * window, which is the safe direction.
 *
 * If holding the assertion fails (a `caffeinate` spawn failure), it is surfaced via the app
 * error banner instead of letting the toggle read "on" while the Mac quietly sleeps — the
 * "zero silent error" rule.
 */
export function useAwakeAssertion(desired: boolean, releaseGraceMs: number): void {
  // Whether the last intent we pushed was a hold — i.e. whether there is anything to linger on.
  // Stays true through the grace window: the Mac IS still held until the release goes out.
  const held = useRef(false);

  useEffect(() => {
    if (!desired) {
      const release = () => {
        held.current = false;
        void setAwakeSerialized(false);
      };
      if (!held.current || releaseGraceMs <= 0) {
        release();
        return;
      }
      const id = setTimeout(release, releaseGraceMs);
      return () => clearTimeout(id);
    }

    held.current = true;
    const push = async () => {
      const res = await setAwakeSerialized(true);
      // Only a hold can fail; a release never does. Surface it so the user knows the Mac may
      // sleep despite the toggle showing "on". Deduped by message.
      if (res.status === "error") {
        useAppErrors
          .getState()
          .pushError("Couldn't keep the Mac awake — it may go to sleep.", res.error);
      }
    };
    void push();
    // While the assertion is meant to be HELD, re-assert it on a slow heartbeat. This effect
    // only re-runs when its inputs change, so if the `caffeinate` child dies out from under us
    // while `desired` stays true (killall, an OS reap under pressure) nothing else calls
    // set_awake again — the Rust-side liveness prune + respawn in `hold()` only runs when
    // invoked. A cheap idempotent re-assert (a no-op while the child is alive) closes that
    // self-heal gap.
    const id = setInterval(() => void push(), REASSERT_MS);
    return () => clearInterval(id);
  }, [desired, releaseGraceMs]);
}
