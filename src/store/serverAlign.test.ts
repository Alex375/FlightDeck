import { describe, expect, it } from "vitest";
import type { MachineHealth } from "./machineHealth";
import { reachedAgain, serverClaudeVersion } from "./serverAlign";

const h = (reachable: boolean, checkedAtMs = 1): MachineHealth => ({
  reachable,
  checkedAtMs,
  lastReachedAtMs: reachable ? checkedAtMs : null,
  reason: reachable ? null : "down",
  probeError: null,
});

describe("reachedAgain", () => {
  it("fires when a server comes back within reach — or is first seen there", () => {
    expect(reachedAgain(undefined, h(true))).toBe(true);
    expect(reachedAgain(h(false), h(true))).toBe(true);
    // A probe that never answered is no verdict: reaching it after that is news.
    expect(reachedAgain(h(true, 0), h(true))).toBe(true);
  });

  it("stays quiet while it stays reachable, goes down, or has no real verdict", () => {
    expect(reachedAgain(h(true), h(true, 2))).toBe(false);
    expect(reachedAgain(h(true), h(false))).toBe(false);
    expect(reachedAgain(undefined, h(true, 0))).toBe(false);
    expect(reachedAgain(h(true), undefined)).toBe(false);
  });
});

describe("serverClaudeVersion", () => {
  it("reads the server's claude off the last pass only", () => {
    expect(serverClaudeVersion(undefined)).toBeNull();
    expect(
      serverClaudeVersion({ machine_id: "m", keep_aligned: true, running: false, last: null, last_error: null }),
    ).toBeNull();
  });
});
