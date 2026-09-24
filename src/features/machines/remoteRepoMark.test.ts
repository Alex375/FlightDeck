import { describe, expect, it } from "vitest";
import { lastReachedPhrase, remoteMarkFor } from "./RemoteRepoMark";
import type { MachineHealth } from "../../store/machineHealth";
import type { Machine } from "../../store/conversationsStore";

const machine = (over: Partial<Machine> = {}): Machine => ({
  id: "m1",
  label: "vps-ovh",
  host: "51.83.1.2",
  port: 22,
  user: "deploy",
  identityFile: null,
  addedAt: 0,
  addresses: [],
  ...over,
});

describe("remoteMarkFor", () => {
  it("says nothing about a folder on this Mac", () => {
    expect(remoteMarkFor(null, [machine()])).toEqual({ kind: "local" });
    expect(remoteMarkFor(undefined, [machine()])).toEqual({ kind: "local" });
  });

  it("names the server a repository lives on, with its ssh target", () => {
    expect(remoteMarkFor("m1", [machine()])).toEqual({
      kind: "remote",
      label: "vps-ovh",
      target: "deploy@51.83.1.2:22",
    });
  });

  it("picks the right server out of a fleet", () => {
    const fleet = [machine(), machine({ id: "m2", label: "build-box", host: "10.0.0.5", user: "ci" })];
    expect(remoteMarkFor("m2", fleet)).toEqual({
      kind: "remote",
      label: "build-box",
      target: "ci@10.0.0.5:22",
    });
  });

  // ⚠️ The regression this mark exists to prevent: a repository whose machine cannot be
  // named is still a repository whose files and agents live on a server. Reading an
  // unresolvable `machineId` as "local" would show it exactly like a folder on this Mac —
  // the confusion the badge was added to end.
  it("still reads as remote when the machine id names no paired machine", () => {
    expect(remoteMarkFor("gone", [machine()])).toEqual({ kind: "unknown" });
    expect(remoteMarkFor("m1", [])).toEqual({ kind: "unknown" });
  });
});

describe("lastReachedPhrase", () => {
  const health = (lastReachedAtMs: number | null): MachineHealth => ({
    reachable: false,
    checkedAtMs: 1_000_000,
    lastReachedAtMs,
    reason: "could not reach the server",
    probeError: null,
  });

  // A machine that has never answered since launch has no duration to state. Saying
  // "0 min ago" there would be a fabricated fact about a server we have simply never
  // spoken to — the caller writes its own sentence instead.
  it("has nothing to say about a machine that never answered", () => {
    expect(lastReachedPhrase(health(null), 1_000_000)).toBeNull();
  });

  it("reads a fresh outage as just now, then in minutes, hours and days", () => {
    const now = 1_000_000;
    expect(lastReachedPhrase(health(now - 5_000), now)).toBe("just now");
    expect(lastReachedPhrase(health(now - 4 * 60_000), now)).toBe("4 min ago");
    expect(lastReachedPhrase(health(now - 3 * 3_600_000), now)).toBe("3 h ago");
    expect(lastReachedPhrase(health(now - 2 * 86_400_000), now)).toBe("2 d ago");
  });

  // Clocks move backwards (NTP, sleep/wake). "in -3 minutes" is worse than "just now".
  it("never reports a negative age", () => {
    expect(lastReachedPhrase(health(2_000_000), 1_000_000)).toBe("just now");
  });
});
