// The battery gate of the closed-lid modes: no optimistic arm before the first reading, the
// floor and its hysteresis, a failed read that keeps the last reading AND says so, polling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PowerSource } from "../../ipc/client";

type PowerResult = { status: "ok"; data: PowerSource } | { status: "error"; error: string };
const powerSource = vi.fn(async (): Promise<PowerResult> => ({ status: "ok", data: batt(80) }));
vi.mock("../../ipc/client", () => ({ commands: { powerSource: () => powerSource() } }));

import { useAppErrors } from "../../store/appErrors";
import { useSleepLock } from "../../store/sleepLock";
import { BATTERY_POLL_MS, useBatteryGate } from "./useBatteryGate";

function batt(percent: number | null, on_battery = true): PowerSource {
  return { on_battery, percent, low_power_mode: false };
}

let container: HTMLDivElement;
let root: Root;
let seen: boolean[] = [];

function Host({ active, floor }: { active: boolean; floor: number }) {
  seen.push(useBatteryGate(active, floor));
  return null;
}

async function render(active: boolean, floor = 20) {
  await act(async () => {
    root.render(createElement(Host, { active, floor }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const latest = () => seen[seen.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  seen = [];
  powerSource.mockReset();
  powerSource.mockImplementation(async () => ({ status: "ok", data: batt(80) }));
  useSleepLock.setState({ status: null, lastError: null, power: null, powerError: null });
  useAppErrors.setState({ errors: [] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useBatteryGate", () => {
  it("never allows the lid hold before the first reading", async () => {
    let resolve!: (r: PowerResult) => void;
    powerSource.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    await render(true);
    expect(seen.every((v) => v === false)).toBe(true);
    await act(async () => {
      resolve({ status: "ok", data: batt(80) });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest()).toBe(true);
  });

  it("a first reading under the floor never arms", async () => {
    powerSource.mockImplementation(async () => ({ status: "ok", data: batt(4) }));
    await render(true);
    expect(seen).not.toContain(true);
  });

  it("is off and polls nothing while no closed-lid mode is armed", async () => {
    await render(false);
    await advance(BATTERY_POLL_MS * 2);
    expect(powerSource).not.toHaveBeenCalled();
    expect(latest()).toBe(false);
  });

  it("polls every minute and applies the floor with hysteresis", async () => {
    await render(true, 20);
    expect(latest()).toBe(true);
    powerSource.mockImplementation(async () => ({ status: "ok", data: batt(20) }));
    await advance(BATTERY_POLL_MS);
    expect(latest()).toBe(false);
    powerSource.mockImplementation(async () => ({ status: "ok", data: batt(24) }));
    await advance(BATTERY_POLL_MS);
    expect(latest()).toBe(false); // under floor + margin
    powerSource.mockImplementation(async () => ({ status: "ok", data: batt(25) }));
    await advance(BATTERY_POLL_MS);
    expect(latest()).toBe(true);
    expect(powerSource).toHaveBeenCalledTimes(4);
  });

  it("a failed read keeps the last decision and reading, and says the floor is not enforced", async () => {
    powerSource.mockImplementation(async () => ({ status: "ok", data: batt(10) }));
    await render(true);
    expect(latest()).toBe(false);
    powerSource.mockImplementation(async () => ({ status: "error", error: "pmset failed" }));
    await advance(BATTERY_POLL_MS);
    expect(latest()).toBe(false);
    expect(useSleepLock.getState().power?.percent).toBe(10); // last good reading kept
    expect(useSleepLock.getState().powerError).toBe("pmset failed");
    expect(useAppErrors.getState().errors.map((e) => e.message)).toEqual([
      expect.stringContaining("battery floor isn't enforced"),
    ]);
  });

  it("a read that fails from the start allows the chosen mode, loudly", async () => {
    powerSource.mockImplementation(async () => ({ status: "error", error: "pmset failed" }));
    await render(true);
    expect(latest()).toBe(true);
    expect(useSleepLock.getState().powerError).toBe("pmset failed");
  });

  it("clears its reading when the closed-lid mode is turned off", async () => {
    await render(true);
    expect(useSleepLock.getState().power).not.toBeNull();
    await render(false);
    expect(useSleepLock.getState().power).toBeNull();
    expect(latest()).toBe(false);
  });
});
