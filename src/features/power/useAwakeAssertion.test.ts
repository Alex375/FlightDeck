// Timing tests for the keep-awake driver, rendered through react-dom/client with fake timers.
// Built with createElement so the file stays a `*.test.ts` (the vitest glob), no JSX.
//
// What is locked here is the 2026-09-18 regression: in an activity-following mode the release
// must NOT go out the instant activity drops — a follow-up turn only reads as busy seconds
// later, and a Mac idle past its sleep timer sleeps within ~5 s of the release. Plus the
// closed-lid contract: the `lid` level arms the system flag ON TOP of the assertion, a refused
// flag keeps the assertion and is surfaced, a release of the flag goes out whenever there is
// (or may be) one of ours — including behind an arm still in flight — and a failed release is
// retried on the heartbeat until it succeeds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SleepLockStatus } from "../../ipc/client";
import type { AwakeHold } from "../../store/caffeinate";

const lockStatus = (on: boolean, owned = on): SleepLockStatus => ({
  supported: true,
  user: "u",
  granted: true,
  system_sleep_disabled: on,
  owned,
  deadman_alive: owned,
  sudoers_path: "/etc/sudoers.d/flightdeck",
  sudoers_line: "u ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1",
  probe_error: null,
  reconcile_error: null,
});
type AwakeResult = { status: "ok"; data: null } | { status: "error"; error: string };
type LockResult = { status: "ok"; data: SleepLockStatus } | { status: "error"; error: string };

const setAwake = vi.fn(async (_awake: boolean): Promise<AwakeResult> => ({ status: "ok", data: null }));
const setSleepDisabled = vi.fn(
  async (on: boolean): Promise<LockResult> => ({ status: "ok", data: lockStatus(on) }),
);
const sleepLockStatus = vi.fn(async (): Promise<LockResult> => ({ status: "ok", data: lockStatus(false) }));
vi.mock("../../ipc/client", () => ({
  commands: {
    setAwake: (a: boolean) => setAwake(a),
    setSleepDisabled: (on: boolean) => setSleepDisabled(on),
    sleepLockStatus: () => sleepLockStatus(),
  },
}));

import { useAppErrors } from "../../store/appErrors";
import { useSleepLock } from "../../store/sleepLock";
import { __resetAwakeDriverForTests, REASSERT_MS, useAwakeAssertion } from "./useAwakeAssertion";

const GRACE = 60_000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  __resetAwakeDriverForTests();
  setAwake.mockReset();
  setAwake.mockImplementation(async () => ({ status: "ok", data: null }));
  setSleepDisabled.mockReset();
  setSleepDisabled.mockImplementation(async (on: boolean) => ({ status: "ok", data: lockStatus(on) }));
  sleepLockStatus.mockReset();
  sleepLockStatus.mockImplementation(async () => ({ status: "ok", data: lockStatus(false) }));
  useSleepLock.setState({ status: null, lastError: null, power: null, powerError: null });
  useAppErrors.setState({ errors: [] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function Host({ hold, grace }: { hold: AwakeHold; grace: number }) {
  useAwakeAssertion(hold, grace);
  return null;
}

/** Render, then let the serialized IPC chain (promise microtasks) settle. */
async function render(hold: AwakeHold | boolean, grace = GRACE) {
  const level: AwakeHold = hold === true ? "idle" : hold === false ? "off" : hold;
  await act(async () => {
    root.render(createElement(Host, { hold: level, grace }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The `set_awake` intents pushed so far, in order. */
const intents = () => setAwake.mock.calls.map(([a]) => a);
/** The `set_sleep_disabled` intents pushed so far, in order. */
const lidIntents = () => setSleepDisabled.mock.calls.map(([a]) => a);
const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];
const bannerMessages = () => useAppErrors.getState().errors.map((e) => e.message);

describe("useAwakeAssertion — grace and heartbeat", () => {
  it("holds, then releases only once the grace window has passed", async () => {
    await render(true);
    expect(intents()).toEqual([true]);

    await render(false);
    await advance(GRACE - 1);
    expect(intents()).not.toContain(false); // activity dropped: still held (heartbeat included)

    await advance(1);
    expect(last(intents())).toBe(false);
  });

  it("never releases when activity comes back within the window", async () => {
    await render(true);
    await render(false);
    await advance(6_000); // the follow-up turn goes busy a few seconds later
    await render(true);

    await advance(GRACE * 3);
    expect(intents()).not.toContain(false);
  });

  it("releases at once when there is no grace (Caffeinate turned off)", async () => {
    await render(true, 0);
    await render(false, 0);
    expect(intents()).toEqual([true, false]);
  });

  it("releases at once when the grace is dropped mid-window", async () => {
    await render(true);
    await render(false);
    await advance(10_000);
    expect(intents()).toEqual([true]);

    await render(false, 0); // the user turns Caffeinate off during the linger
    expect(intents()).toEqual([true, false]);

    await advance(GRACE);
    expect(intents()).toEqual([true, false]); // nothing held, no release pending: silent
  });

  it("releases at once on mount when nothing was ever held, then stays quiet", async () => {
    await render(false);
    expect(intents()).toEqual([false]);
    await advance(REASSERT_MS * 3);
    expect(intents()).toEqual([false]);
  });

  it("re-asserts the hold on a heartbeat while desired", async () => {
    await render(true);
    await advance(REASSERT_MS);
    expect(intents()).toEqual([true, true]);
  });

  it("a grace-delayed downgrade to the open-lid hold keeps its heartbeat", async () => {
    await render("lid");
    await render("idle"); // battery floor in Night Watch: lingers a grace minute
    await advance(GRACE);
    // The heartbeat re-asserted the still-held `lid` during the window, then the downgrade went out.
    expect(last(lidIntents())).toBe(false);
    const flagCalls = lidIntents().length;
    const before = intents().length;
    await advance(REASSERT_MS);
    expect(intents().length).toBe(before + 1);
    expect(last(intents())).toBe(true);
    expect(lidIntents().length).toBe(flagCalls); // the flag is not re-armed (nor re-released)
  });
});

describe("useAwakeAssertion — the closed-lid flag", () => {
  it("an open-lid hold never touches the system sleep flag", async () => {
    await render("idle");
    await advance(REASSERT_MS);
    await render("off", 0);
    await advance(REASSERT_MS);
    expect(lidIntents()).toEqual([]);
  });

  it("the lid level arms the flag on top of the assertion, and releases it on the way down", async () => {
    await render("lid", 0);
    expect(intents()).toEqual([true]);
    expect(lidIntents()).toEqual([true]);
    expect(useSleepLock.getState().status?.system_sleep_disabled).toBe(true);

    await render("idle", 0); // battery floor: keep the assertion, drop the flag
    expect(intents()).toEqual([true, true]);
    expect(lidIntents()).toEqual([true, false]);
    expect(useSleepLock.getState().status?.system_sleep_disabled).toBe(false);
  });

  it("a lid downgrade lingers for the grace like any release (Night Watch going idle)", async () => {
    await render("lid");
    await render("off");
    await advance(GRACE - 1);
    expect(lidIntents()).not.toContain(false); // still armed through the window
    await advance(1);
    expect(last(lidIntents())).toBe(false);
    expect(last(intents())).toBe(false);
  });

  it("a release issued while the arm is still in flight is not skipped", async () => {
    // Hold the first setAwake so the arm is queued behind it when the release is issued.
    let unblock!: () => void;
    setAwake.mockImplementationOnce(
      () => new Promise<AwakeResult>((r) => (unblock = () => r({ status: "ok", data: null }))),
    );
    await render("lid", 0);
    await render("off", 0); // toggled back off before the arm's round trip returned
    expect(lidIntents()).toEqual([]);
    await act(async () => {
      unblock();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lidIntents()).toEqual([true, false]);
    expect(useSleepLock.getState().status?.system_sleep_disabled).toBe(false);
  });

  it("a refused flag keeps the assertion, re-reads the real status, and is surfaced", async () => {
    setSleepDisabled.mockImplementation(async () => ({
      status: "error",
      error: "sudo: a password is required",
    }));
    sleepLockStatus.mockImplementation(async () => ({
      status: "ok",
      data: { ...lockStatus(false), granted: false },
    }));
    await render("lid", 0);
    expect(intents()).toEqual([true]); // caffeinate still holds the Mac while the lid is open
    expect(useSleepLock.getState().lastError).toBe("sudo: a password is required");
    expect(useSleepLock.getState().status?.granted).toBe(false); // not the stale "granted"
    expect(bannerMessages()).toEqual([expect.stringContaining("lid-proof")]);
  });

  it("a failed release is retried on the heartbeat until it succeeds, then goes quiet", async () => {
    await render("lid", 0);
    setSleepDisabled.mockImplementation(async (on: boolean) =>
      on ? { status: "ok", data: lockStatus(true) } : { status: "error", error: "pmset -g failed" },
    );
    sleepLockStatus.mockImplementation(async () => ({ status: "ok", data: lockStatus(true) }));
    await render("off", 0);
    expect(lidIntents()).toEqual([true, false]);
    expect(bannerMessages()).toEqual([expect.stringContaining("Couldn't re-enable sleep")]);

    await advance(REASSERT_MS);
    expect(lidIntents()).toEqual([true, false, false]); // retried

    setSleepDisabled.mockImplementation(async (on: boolean) => ({ status: "ok", data: lockStatus(on) }));
    await advance(REASSERT_MS);
    expect(lidIntents()).toEqual([true, false, false, false]); // this one succeeds
    await advance(REASSERT_MS * 3);
    expect(lidIntents()).toEqual([true, false, false, false]); // and nothing more
  });

  it("releases a flag we own even if this driver never armed it (a previous run's leftover)", async () => {
    useSleepLock.setState({ status: lockStatus(true) });
    await render("off", 0);
    expect(lidIntents()).toEqual([false]);
  });

  it("retries the leftover release on the heartbeat when the launch status arrives late", async () => {
    await render("off", 0);
    expect(lidIntents()).toEqual([]);
    useSleepLock.setState({ status: { ...lockStatus(true), reconcile_error: "pmset -g failed" } });
    await advance(REASSERT_MS);
    expect(lidIntents()).toEqual([false]);
  });

  it("never releases a flag that is not ours", async () => {
    useSleepLock.setState({ status: lockStatus(true, false) }); // set by hand
    await render("off", 0);
    await advance(REASSERT_MS * 2);
    expect(lidIntents()).toEqual([]);
  });
});
