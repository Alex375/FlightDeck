import { describe, expect, it } from "vitest";
import { remoteMarkFor } from "./RemoteRepoMark";
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
