import { describe, expect, it } from "vitest";
import type { SleepLockStatus } from "../ipc/client";
import { lidModesAvailable, lidModesBlockedReason, lidProofEngaged, sleepLockStale } from "./sleepLock";

const base: SleepLockStatus = {
  supported: true,
  user: "u",
  granted: true,
  system_sleep_disabled: false,
  owned: false,
  deadman_alive: false,
  sudoers_path: "/etc/sudoers.d/flightdeck",
  sudoers_line: "",
  probe_error: null,
  reconcile_error: null,
};
const s = (patch: Partial<SleepLockStatus>): SleepLockStatus => ({ ...base, ...patch });

describe("sleepLockStale", () => {
  it("is true only for OUR flag, still set, with the authorization gone", () => {
    for (const owned of [false, true])
      for (const system_sleep_disabled of [false, true])
        for (const granted of [false, true]) {
          const expected = owned && system_sleep_disabled && !granted;
          expect(sleepLockStale(s({ owned, system_sleep_disabled, granted }))).toBe(expected);
        }
    expect(sleepLockStale(null)).toBe(false);
  });

  it("never shouts about a flag the user set by hand", () => {
    expect(sleepLockStale(s({ owned: false, system_sleep_disabled: true, granted: false }))).toBe(false);
  });
});

describe("lidProofEngaged", () => {
  it("needs the flag set AND ours", () => {
    expect(lidProofEngaged(s({ owned: true, system_sleep_disabled: true }))).toBe(true);
    expect(lidProofEngaged(s({ owned: false, system_sleep_disabled: true }))).toBe(false);
    expect(lidProofEngaged(s({ owned: true, system_sleep_disabled: false }))).toBe(false);
    expect(lidProofEngaged(null)).toBe(false);
  });
});

describe("lidModesAvailable / lidModesBlockedReason", () => {
  it("is available only when supported and granted, with no reason", () => {
    expect(lidModesAvailable(s({}))).toBe(true);
    expect(lidModesBlockedReason(s({}))).toBeNull();
  });

  it("gives a neutral reason before the first read, never a false 'not authorized'", () => {
    expect(lidModesAvailable(null)).toBe(false);
    expect(lidModesBlockedReason(null)).toMatch(/Checking/);
  });

  it("explains each blocked case", () => {
    expect(lidModesBlockedReason(s({ supported: false, granted: false }))).toMatch(/macOS/);
    expect(lidModesBlockedReason(s({ granted: false, probe_error: "sudo exploded" }))).toMatch(/sudo exploded/);
    expect(lidModesBlockedReason(s({ granted: false }))).toMatch(/one-time admin authorization/);
    expect(lidModesAvailable(s({ granted: false }))).toBe(false);
  });
});
