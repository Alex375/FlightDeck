// Drives the Rust `power` service from a desired hold level. Split out of CaffeinateHost so
// the timing (serialized IPC, re-assert heartbeat, release grace) can be tested without
// mounting the fleet stores that compute the hold.
import { useEffect, useRef } from "react";
import { commands } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import type { AwakeHold } from "../../store/caffeinate";
import { useSleepLock } from "../../store/sleepLock";

/** Slow heartbeat re-asserting the hold: if the `caffeinate` child is killed out from under
 *  us (or the system sleep flag flipped back by hand) while it should stay held, the next tick
 *  pushes the same hold again and the idempotent Rust side converges it. Cheap (a no-op while
 *  everything is as it should be). It also keeps the closed-lid status fresh for the UI. */
const REASSERT_MS = 30_000;

/** Ordering of the hold levels, so a change can be told apart as an upgrade (apply at once)
 *  or a downgrade (may linger for the release grace). */
const LEVEL: Record<AwakeHold, number> = { off: 0, idle: 1, lid: 2 };

// Serialize every power IPC so the calls apply in ISSUE ORDER and the last intent wins.
// The heartbeat above can have an in-flight hold that — without this — could reach the Rust
// mutex AFTER a near-simultaneous release (Tauri does not guarantee cross-invoke ordering) and
// strand the Mac held awake, with no further heartbeat to self-correct while the hold is
// off. Chaining makes a later-issued release always win. Same "serialize the writes to a
// shared resource" discipline as the CLI-config writers.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(call: () => Promise<T>): Promise<T> {
  const next = chain.then(call);
  chain = next.catch(() => {}); // keep the chain alive past a rejection
  return next;
}

/** Whether the LAST push armed the system sleep flag — so a release knows it has something to
 *  undo without probing sudo on every Light/Hard heartbeat. */
let lastPushWasLid = false;

/** Push one hold level to the core: the `caffeinate` assertion for any hold, plus the system
 *  sleep flag for `lid`. Each failure is surfaced via the app error banner instead of letting
 *  the toggle read "on" while the Mac quietly sleeps — the "zero silent error" rule. A refused
 *  lid flag still leaves the assertion held (belt and braces), and says so. */
export async function pushHold(hold: AwakeHold): Promise<void> {
  const errors = useAppErrors.getState();
  const awake = await serialized(() => commands.setAwake(hold !== "off"));
  if (awake.status === "error") {
    errors.pushError("Couldn't keep the Mac awake — it may go to sleep.", awake.error);
  }
  const lock = useSleepLock.getState();
  // Only touch the system flag when arming it, or when there is (or may be) one of ours to
  // release: a Light/Hard user never spawns `sudo` on a heartbeat.
  const mustRelease = lastPushWasLid || !!lock.status?.owned;
  if (hold !== "lid" && !mustRelease) return;
  const res = await serialized(() => commands.setSleepDisabled(hold === "lid"));
  lastPushWasLid = hold === "lid";
  if (res.status === "ok") {
    lock.setStatus(res.data);
    lock.setError(null);
    return;
  }
  lock.setError(res.error);
  if (hold === "lid") {
    errors.pushError(
      "Couldn't make the Mac lid-proof — it will sleep when the lid closes (it is still kept awake while open).",
      res.error,
    );
  } else {
    errors.pushError(
      "Couldn't re-enable sleep — the Mac may stay awake. See Settings → General → System.",
      res.error,
    );
  }
}

/**
 * Hold the Mac at `hold`, releasing (downgrading) otherwise — but a downgrade that follows a
 * hold waits `releaseGraceMs` first, and is cancelled if the hold comes back within that window
 * (nothing is released, so nothing to re-arm either). `0` downgrades at once. The grace is
 * read when the downgrade starts: dropping it to `0` mid-window downgrades immediately.
 *
 * WebKit may throttle the grace timer while the window is hidden; that only lengthens the
 * window, which is the safe direction.
 */
export function useAwakeAssertion(hold: AwakeHold, releaseGraceMs: number): void {
  // The last hold we actually pushed — i.e. whether there is anything to linger on. Stays at
  // the higher level through the grace window: the Mac IS still held until the release goes out.
  const held = useRef<AwakeHold>("off");

  useEffect(() => {
    const downgrade = LEVEL[hold] < LEVEL[held.current];
    if (downgrade && releaseGraceMs > 0) {
      const id = setTimeout(() => {
        held.current = hold;
        void pushHold(hold);
      }, releaseGraceMs);
      return () => clearTimeout(id);
    }

    held.current = hold;
    void pushHold(hold);
    if (hold === "off") return;
    // While a hold is meant to be kept, re-assert it on a slow heartbeat. This effect only
    // re-runs when its inputs change, so if the `caffeinate` child dies out from under us
    // while the hold stays wanted (killall, an OS reap under pressure) nothing else pushes
    // again — the Rust-side liveness prune + respawn only runs when invoked. A cheap
    // idempotent re-assert closes that self-heal gap.
    const id = setInterval(() => void pushHold(hold), REASSERT_MS);
    return () => clearInterval(id);
  }, [hold, releaseGraceMs]);
}
