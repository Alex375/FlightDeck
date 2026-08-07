import { describe, it, expect } from "vitest";
import { bypassBlockedReason } from "./permissions";

describe("bypassBlockedReason", () => {
  it("blocks — and points at the setting — while the app-wide opt-in is off", () => {
    // Off is off whatever the session looks like: not spawned, spawned without the
    // flag, or (impossible in practice) spawned with it.
    for (const [live, sessionAllows] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      expect(bypassBlockedReason(false, live, sessionAllows)).toMatch(/Settings/);
    }
  });

  it("allows the pick once opted in and no process is running — the next spawn carries the flag", () => {
    expect(bypassBlockedReason(true, false, false)).toBeNull();
  });

  it("allows it on a live session that WAS spawned with the flag", () => {
    expect(bypassBlockedReason(true, true, true)).toBeNull();
  });

  it("blocks — asking for a restart — on a session spawned before the opt-in", () => {
    // The unlock is a spawn flag: a running process can never gain it. Sending the
    // pick anyway would have the CLI silently downgrade it to `default`.
    expect(bypassBlockedReason(true, true, false)).toMatch(/[Rr]estart/);
  });
});
