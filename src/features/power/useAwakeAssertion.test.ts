// Timing tests for the keep-awake driver, rendered through react-dom/client with fake timers.
// Built with createElement so the file stays a `*.test.ts` (the vitest glob), no JSX.
//
// What is locked here is the 2026-09-18 regression: in an activity-following mode the release
// must NOT go out the instant activity drops — a follow-up turn only reads as busy seconds
// later, and a Mac idle past its sleep timer sleeps within ~5 s of the release. Plus the
// closed-lid contract: the `lid` level arms the system flag ON TOP of the assertion, a refused
// flag keeps the assertion and is surfaced, and a release of the flag only goes out when there
// is one of ours to release.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AwakeHold } from "../../store/caffeinate";

const setAwake = vi.fn(async (_awake: boolean) => ({ status: "ok" as const, data: null }));
const lockStatus = (on: boolean) => ({
  supported: true,
  user: "u",
  granted: true,
  system_sleep_disabled: on,
  owned: on,
  deadman_alive: on,
  sudoers_path: "/etc/sudoers.d/flightdeck",
  sudoers_line: "u ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1",
  probe_error: null,
});
type LockResult = { status: "ok"; data: ReturnType<typeof lockStatus> } | { status: "error"; error: string };
const setSleepDisabled = vi.fn(
  async (on: boolean): Promise<LockResult> => ({ status: "ok", data: lockStatus(on) }),
);
vi.mock("../../ipc/client", () => ({
  commands: {
    setAwake: (a: boolean) => setAwake(a),
    setSleepDisabled: (on: boolean) => setSleepDisabled(on),
    sleepLockStatus: async () => ({ status: "ok", data: lockStatus(false) }),
  },
}));

import { useAppErrors } from "../../store/appErrors";
import { useSleepLock } from "../../store/sleepLock";
import { useAwakeAssertion } from "./useAwakeAssertion";

const GRACE = 60_000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setAwake.mockClear();
  setSleepDisabled.mockClear();
  setSleepDisabled.mockImplementation(async (on: boolean) => ({ status: "ok", data: lockStatus(on) }));
  useSleepLock.setState({ status: null, lastError: null, power: null });
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

describe("useAwakeAssertion", () => {
  it("holds, then releases only once the grace window has passed", async () => {
    await render(true);
    expect(intents()).toEqual([true]);

    await render(false);
    expect(intents()).toEqual([true]); // activity dropped: still held

    await advance(GRACE - 1);
    expect(intents()).toEqual([true]);

    await advance(1);
    expect(intents()).toEqual([true, false]);
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
    expect(intents()).toEqual([true, false]); // the cancelled timer does not fire again
  });

  it("releases at once on mount when nothing was ever held", async () => {
    await render(false);
    expect(intents()).toEqual([false]);
  });

  it("re-asserts the hold on a heartbeat while desired", async () => {
    await render(true);
    await advance(30_000);
    expect(intents()).toEqual([true, true]);
  });

  it("an open-lid hold never touches the system sleep flag", async () => {
    await render("idle");
    await advance(30_000);
    await render("off", 0);
    expect(lidIntents()).toEqual([]);
  });

  it("the lid level arms the system flag on top of the assertion, and releases it on the way down", async () => {
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
    expect(lidIntents()).toEqual([true]); // still armed through the window
    await advance(GRACE);
    expect(lidIntents()).toEqual([true, false]);
    expect(intents()).toEqual([true, false]);
  });

  it("a refused flag keeps the assertion held and is surfaced, never silent", async () => {
    setSleepDisabled.mockImplementation(async () => ({
      status: "error",
      error: "sudo: a password is required",
    }));
    await render("lid", 0);
    expect(intents()).toEqual([true]); // caffeinate still holds the Mac while the lid is open
    expect(useSleepLock.getState().lastError).toBe("sudo: a password is required");
    expect(useAppErrors.getState().errors.map((e) => e.message)).toEqual([
      expect.stringContaining("lid-proof"),
    ]);
  });

  it("releases a flag we own even if this driver never armed it (a previous run's leftover)", async () => {
    useSleepLock.setState({ status: lockStatus(true) });
    await render("off", 0);
    expect(lidIntents()).toEqual([false]);
  });
});
