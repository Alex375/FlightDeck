// Timing tests for the keep-awake driver, rendered through react-dom/client with fake timers.
// Built with createElement so the file stays a `*.test.ts` (the vitest glob), no JSX.
//
// What is locked here is the 2026-09-18 regression: in Light mode the release must NOT go out
// the instant activity drops — a follow-up turn only reads as busy seconds later, and a Mac
// idle past its sleep timer sleeps within ~5 s of the release.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const setAwake = vi.fn(async (_awake: boolean) => ({ status: "ok" as const, data: null }));
vi.mock("../../ipc/client", () => ({ commands: { setAwake: (a: boolean) => setAwake(a) } }));

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
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function Host({ desired, grace }: { desired: boolean; grace: number }) {
  useAwakeAssertion(desired, grace);
  return null;
}

/** Render, then let the serialized IPC chain (promise microtasks) settle. */
async function render(desired: boolean, grace = GRACE) {
  await act(async () => {
    root.render(createElement(Host, { desired, grace }));
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
});
