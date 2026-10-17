import { describe, expect, it } from "vitest";
import type { MachineHealth } from "../../store/machineHealth";
import { lastReachedLine, serverFault } from "./serverFault";

const NOW = 10_000_000;
const health = (over: Partial<MachineHealth> = {}): MachineHealth => ({
  reachable: false,
  checkedAtMs: NOW - 3 * 60_000,
  lastReachedAtMs: NOW - 20 * 60_000,
  reason: "could not reach the server",
  probeError: null,
  ...over,
});

describe("serverFault", () => {
  it("says an unreachable server with how old the check is and since when it is gone", () => {
    expect(serverFault(health(), { online: true, nowMs: NOW })).toEqual({
      kind: "unreachable",
      reason: "could not reach the server",
      checked: "3 min ago",
      lastReached: "20 min ago",
    });
  });

  it("blames this Mac, never the server, when this Mac is offline — whatever the verdict", () => {
    expect(serverFault(health(), { online: false, nowMs: NOW })).toEqual({ kind: "macOffline" });
    expect(serverFault(undefined, { online: false, nowMs: NOW })).toEqual({ kind: "macOffline" });
  });

  it("is no fault at all without a verdict, or with a reachable one", () => {
    expect(serverFault(undefined, { online: true, nowMs: NOW })).toBeNull();
    expect(serverFault(health({ reachable: true }), { online: true, nowMs: NOW })).toBeNull();
    // A row that only recorded a failed check: we failed to ask, the server is not accused.
    expect(serverFault(health({ reachable: true, checkedAtMs: 0 }), { online: true, nowMs: NOW })).toBeNull();
  });
});

describe("lastReachedLine", () => {
  it("says when, or that it never answered since the app started", () => {
    expect(lastReachedLine("4 min ago")).toBe("Last reached 4 min ago");
    expect(lastReachedLine(null)).toBe("Not reached since the app started");
  });
});
