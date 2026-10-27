// Drives the Rust `power` service from a desired hold level. Split out of CaffeinateHost so
// the timing (serialized IPC, re-assert heartbeat, release grace) can be tested without
// mounting the fleet stores that compute the hold.
import { useEffect, useRef } from "react";
import { commands } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import type { AwakeHold } from "../../store/caffeinate";
import { useSleepLock } from "../../store/sleepLock";
import { MACHINE } from "../../ui/platform";

/** Slow heartbeat re-asserting the hold: if the `caffeinate` child is killed out from under
 *  us (or the system sleep flag flipped back by hand) while it should stay held, the next tick
 *  pushes the same hold again and the idempotent Rust side converges it. Cheap (a no-op while
 *  everything is as it should be). With nothing held it only ticks while a release of OUR
 *  sleep flag is still outstanding — so a failed release is retried, never forgotten. */
export const REASSERT_MS = 30_000;

/** Ordering of the hold levels, so a change can be told apart as an upgrade (apply at once)
 *  or a downgrade (may linger for the release grace). */
const LEVEL: Record<AwakeHold, number> = { off: 0, idle: 1, lid: 2 };

// Serialize every push so they apply in ISSUE ORDER and the last intent wins. The heartbeat
// can have an in-flight hold that — without this — could reach the Rust mutex AFTER a
// near-simultaneous release (Tauri does not guarantee cross-invoke ordering) and strand the
// Mac held awake. A WHOLE push (assertion + flag + the decision between them) is one link of
// the chain: deciding "is there a flag to release?" before an earlier arm has even run would
// skip the release of a flag that arm is about to set.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(call: () => Promise<T>): Promise<T> {
  const next = chain.then(call);
  chain = next.catch(() => {}); // keep the chain alive past a rejection
  return next;
}

/** A `lid` push went out and no release has been confirmed since — so there may be a flag of
 *  ours to release, even before any status read says so. Set BEFORE the arm call (an arm that
 *  fails half-way may still have set the flag), cleared only by a successful release. */
let lidArmed = false;

/** There is (or may be) a system sleep flag of ours to release. */
export function releasePending(): boolean {
  return lidArmed || !!useSleepLock.getState().status?.owned;
}

/** Test-only: reset the module state shared across renders (the chain and the arm record),
 *  so one test's leftovers cannot make another pass. */
export function __resetAwakeDriverForTests(): void {
  chain = Promise.resolve();
  lidArmed = false;
}

/** Push one hold level to the core: the `caffeinate` assertion for any hold, plus the system
 *  sleep flag for `lid`. Each failure is surfaced via the app error banner instead of letting
 *  the toggle read "on" while the Mac quietly sleeps — the "zero silent error" rule. A refused
 *  lid flag still leaves the assertion held (belt and braces), and says so. */
export function pushHold(hold: AwakeHold): Promise<void> {
  return serialized(async () => {
    const errors = useAppErrors.getState();
    const awake = await commands.setAwake(hold !== "off");
    if (awake.status === "error") {
      errors.pushError(`Couldn't keep the ${MACHINE} awake — it may go to sleep.`, awake.error);
    }
    const wantLid = hold === "lid";
    // Only touch the system flag when arming it, or when there is (or may be) one of ours to
    // release: a Light/Hard user never spawns `sudo` on a heartbeat.
    if (!wantLid && !releasePending()) return;
    if (wantLid) lidArmed = true;
    const lock = useSleepLock.getState();
    const res = await commands.setSleepDisabled(wantLid);
    if (res.status === "ok") {
      lock.setStatus(res.data);
      lock.setError(null);
      if (!wantLid) lidArmed = false;
      return;
    }
    lock.setError(res.error);
    // The error drops the post-attempt state: re-read it, so the tray and Settings stop
    // showing what was true before the failure (e.g. a revoked authorization).
    try {
      const fresh = await commands.sleepLockStatus();
      if (fresh.status === "ok") lock.setStatus(fresh.data);
    } catch {
      /* the error above is already surfaced */
    }
    if (wantLid) {
      errors.pushError(
        "Couldn't make the Mac lid-proof — it will sleep when the lid closes (it is still kept awake while open).",
        res.error,
      );
    } else {
      errors.pushError(
        `Couldn't re-enable sleep — the ${MACHINE} may stay awake. Retrying every 30 s; see Settings → General → System.`,
        res.error,
      );
    }
  });
}

/**
 * Hold the Mac at `hold`, releasing (downgrading) otherwise — but a downgrade that follows a
 * hold waits `releaseGraceMs` first, and is cancelled if the hold comes back within that window
 * (nothing is released, so nothing to re-arm either). `0` downgrades at once. The grace is
 * read when the downgrade starts: dropping it to `0` mid-window downgrades immediately.
 *
 * The heartbeat always re-asserts the level ACTUALLY held — the higher one during a grace
 * window, the lower one once it has gone out — so a grace-delayed downgrade to `idle` keeps
 * its self-heal, and an outstanding release of our sleep flag keeps being retried.
 *
 * WebKit may throttle the grace timer while the window is hidden; that only lengthens the
 * window, which is the safe direction.
 */
export function useAwakeAssertion(hold: AwakeHold, releaseGraceMs: number): void {
  // The level actually pushed last. Stays at the higher level through the grace window: the
  // Mac IS still held until the downgrade goes out.
  const held = useRef<AwakeHold>("off");

  useEffect(() => {
    const apply = () => {
      held.current = hold;
      void pushHold(hold);
    };
    const downgrade = LEVEL[hold] < LEVEL[held.current];
    const timer = downgrade && releaseGraceMs > 0 ? setTimeout(apply, releaseGraceMs) : undefined;
    if (timer === undefined) apply();
    // This effect only re-runs when its inputs change, so if the `caffeinate` child dies out
    // from under us while the hold stays wanted (killall, an OS reap under pressure), or a
    // release fails, nothing else pushes again — the Rust side only converges when invoked.
    const id = setInterval(() => {
      const level = held.current;
      if (level !== "off" || releasePending()) void pushHold(level);
    }, REASSERT_MS);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(id);
    };
  }, [hold, releaseGraceMs]);
}
