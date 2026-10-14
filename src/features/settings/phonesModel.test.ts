import { describe, expect, it } from "vitest";
import type { DeviceServerView, RemoteDevicesStatus, RemoteDeviceView } from "../../ipc/client";
import {
  describeCleartextServer,
  describeDeviceServer,
  describeKey,
  describeLastSeen,
  describeLegacyOwed,
  describePendingRemoval,
  needsRetry,
} from "./phonesModel";

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

function server(over: Partial<DeviceServerView> = {}): DeviceServerView {
  return { machine_id: "m1", machine_label: "build-box", generation: 1, last_outcome: null, ...over };
}

function device(over: Partial<RemoteDeviceView> = {}): RemoteDeviceView {
  return {
    device_id: "d1",
    label: "iPhone",
    added_at: NOW - 10 * DAY,
    last_seen_at: null,
    generation: 1,
    expires_at: NOW + 80 * DAY,
    renew_after: NOW + 20 * DAY,
    push_subscriptions: 0,
    servers: [server()],
    ...over,
  };
}

describe("phonesModel", () => {
  it("says when the phone last connected", () => {
    expect(describeLastSeen(device(), NOW)).toBe("Not connected yet");
    expect(describeLastSeen(device({ last_seen_at: NOW - 3 * 60_000 }), NOW)).toBe("Last connected 3 min ago");
    expect(describeLastSeen(device({ last_seen_at: NOW - 5 * DAY }), NOW)).toBe("Last connected 5 d ago");
  });

  it("flags a key in its last week and once expired, with what to do", () => {
    expect(describeKey(device(), NOW).problem).toBe(false);
    expect(describeKey(device(), NOW).text).toContain("Key renews on its own");
    const soon = describeKey(device({ expires_at: NOW + 1 * DAY }), NOW);
    expect(soon).toEqual({
      text: "Its key expires in 1 day — open the phone app while this Mac is online to renew it.",
      problem: true,
    });
    expect(describeKey(device({ expires_at: NOW }), NOW)).toEqual({
      text: "Its key has expired — pair this phone again.",
      problem: true,
    });
  });

  it("describes each server, naming it and the fix", () => {
    expect(describeDeviceServer(server(), 1)).toEqual({ text: "build-box: ready", problem: false });
    expect(describeDeviceServer(server({ generation: null }), 1)).toEqual({ text: "build-box: setting up…", problem: false });
    expect(describeDeviceServer(server({ generation: 1 }), 2).text).toBe("build-box: setting up…");
    expect(
      describeDeviceServer(server({ generation: null, last_outcome: { kind: "failed", reason: "it couldn't be reached" } }), 1),
    ).toEqual({ text: "build-box: not set up yet — it couldn't be reached", problem: true });
    expect(describeDeviceServer(server({ generation: null, last_outcome: { kind: "daemon_too_old" } }), 1)).toEqual({
      text: "build-box: update its flightdeckd to reach it from this phone",
      problem: true,
    });
  });

  it("explains a removal still owed and offers a retry for any problem", () => {
    const removal = {
      device_id: "d0",
      machine_id: "m1",
      machine_label: "build-box",
      last_outcome: { kind: "failed" as const, reason: "timeout" },
    };
    expect(describePendingRemoval(removal).text).toBe(
      "A revoked phone is still being removed from build-box (timeout). Flight Deck keeps trying on its own.",
    );
    const status = (over: Partial<RemoteDevicesStatus> = {}): RemoteDevicesStatus => ({
      devices: [device()],
      pending_removals: [],
      legacy_revocations_owed: [],
      sync_error: null,
      cleartext_servers: [],
      ...over,
    });
    expect(needsRetry(null)).toBe(false);
    expect(needsRetry(status())).toBe(false);
    expect(needsRetry(status({ pending_removals: [removal] }))).toBe(true);
    expect(
      needsRetry(status({ devices: [device({ servers: [server({ generation: null, last_outcome: { kind: "daemon_too_old" } })] })] })),
    ).toBe(true);
    expect(needsRetry(status({ legacy_revocations_owed: ["build-box"] }))).toBe(true);
    expect(needsRetry(status({ sync_error: "could not read the paired phones" }))).toBe(true);
    const open = { machine_id: "m1", machine_label: "build-box", reason: "it runs flightdeckd 0.4.2" };
    expect(needsRetry(status({ cleartext_servers: [open] }))).toBe(true);
    expect(describeCleartextServer(open)).toEqual({
      text: "build-box still accepts unencrypted commands: it runs flightdeckd 0.4.2.",
      problem: true,
    });
  });

  it("names the servers still holding the retired unencrypted pairing", () => {
    expect(describeLegacyOwed([])).toBeNull();
    expect(describeLegacyOwed(["build-box"])?.text).toBe(
      "build-box still holds the retired unencrypted pairing and may accept unencrypted connections until it is reached. Flight Deck keeps trying on its own — turn it on to finish.",
    );
    expect(describeLegacyOwed(["a", "b"])?.text).toContain("a, b still hold");
  });
});
