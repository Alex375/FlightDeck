import { describe, expect, it } from "vitest";
import type { DeviceServerView, RemoteDevicesStatus, RemoteDeviceView, RemoteStatus } from "../../ipc/client";
import {
  describeProvisionStatus,
  describeRevokeStatus,
  describeSealedServerAccess,
  describeServerPhoneAccess,
  reportsLegacyPairing,
} from "./provisionStatus";

const NOW = 1_800_000_000_000;

function remote(over: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    connected: true,
    relay_url: "https://relay.example",
    mac_id: "mac",
    mac_label: "Mac",
    pairing_url: null,
    pairing_qr_svg: null,
    error: null,
    legacy_active: false,
    refused: false,
    can_rotate: false,
    rotation_pending: false,
    secrets_lost: false,
    ...over,
  };
}

function onServer(over: Partial<DeviceServerView> = {}): DeviceServerView {
  return { machine_id: "m1", machine_label: "build-box", generation: 1, last_outcome: null, ...over };
}

function phone(label: string, servers: DeviceServerView[], generation = 1): RemoteDeviceView {
  return {
    device_id: `d-${label}`,
    label,
    added_at: NOW,
    last_seen_at: null,
    generation,
    expires_at: NOW + 1e10,
    renew_after: NOW + 1e9,
    push_subscriptions: 0,
    servers,
  };
}

function devicesStatus(devices: RemoteDeviceView[], over: Partial<RemoteDevicesStatus> = {}): RemoteDevicesStatus {
  return { devices, pending_removals: [], legacy_revocations_owed: [], sync_error: null, cleartext_servers: [], ...over };
}

describe("describeServerPhoneAccess", () => {
  const sealedReady = devicesStatus([phone("iPhone", [onServer()])]);

  it("waits for the remote status before choosing which pairing to report", () => {
    expect(describeServerPhoneAccess("m1", null, undefined, sealedReady, null, NOW)).toEqual({
      text: "checking…",
      canRetry: false,
      isProblem: false,
    });
  });

  it("keeps reporting the legacy token while that pairing is in use", () => {
    expect(describeServerPhoneAccess("m1", remote({ legacy_active: true }), undefined, sealedReady, null, NOW).text).toBe(
      "not checked yet",
    );
  });

  // Audit sec-secrets#3: a server that never held the legacy token is never given it.
  it("reports the encrypted-channel phones on a server that never held the legacy token, even while it is in use", () => {
    expect(
      describeServerPhoneAccess("m1", remote({ legacy_active: true }), undefined, sealedReady, null, NOW, false).text,
    ).toBe("ready (iPhone)");
    expect(reportsLegacyPairing(remote({ legacy_active: true }), true)).toBe(true);
    expect(reportsLegacyPairing(remote({ legacy_active: true }), false)).toBe(false);
    expect(reportsLegacyPairing(remote(), true)).toBe(false);
  });

  it("reports the encrypted-channel phones once the legacy pairing is retired — never the retired token", () => {
    const legacyFailed = {
      machine_id: "m1",
      state: { kind: "failed" as const, reason: "the unencrypted pairing is retired — nothing to provision" },
      checked_at_ms: NOW,
    };
    expect(describeServerPhoneAccess("m1", remote(), legacyFailed, sealedReady, null, NOW)).toEqual({
      text: "ready (iPhone)",
      canRetry: false,
      isProblem: false,
    });
  });
});

describe("describeSealedServerAccess", () => {
  it("says checking until the phones are read, and names a failed read", () => {
    expect(describeSealedServerAccess("m1", null, null).text).toBe("checking…");
    expect(describeSealedServerAccess("m1", null, "database is locked")).toEqual({
      text: "couldn't read the paired phones: database is locked",
      canRetry: false,
      isProblem: true,
    });
  });

  it("is quiet when no phone is paired", () => {
    expect(describeSealedServerAccess("m1", devicesStatus([]), null)).toEqual({
      text: "no phone paired",
      canRetry: false,
      isProblem: false,
    });
  });

  it("counts the phones ready on THIS server only", () => {
    const status = devicesStatus([
      phone("iPhone", [onServer(), onServer({ machine_id: "m2", generation: null })]),
      phone("iPad", [onServer(), onServer({ machine_id: "m2", generation: null })]),
    ]);
    expect(describeSealedServerAccess("m1", status, null).text).toBe("ready on 2 phones");
    expect(describeSealedServerAccess("m2", status, null)).toEqual({
      text: "0/2 phones ready, setting up the rest…",
      canRetry: false,
      isProblem: false,
    });
  });

  it("treats a key older than the phone's newest generation as not ready yet", () => {
    const status = devicesStatus([phone("iPhone", [onServer({ generation: 1 })], 2)]);
    expect(describeSealedServerAccess("m1", status, null).text).toBe("setting up…");
  });

  it("treats a server missing from the read-back (just paired) as being set up", () => {
    const status = devicesStatus([phone("iPhone", [onServer()])]);
    expect(describeSealedServerAccess("m-new", status, null).text).toBe("setting up…");
  });

  it("names the failing phone and its reason, with Retry", () => {
    const failed = onServer({ generation: null, last_outcome: { kind: "failed", reason: "it couldn't be reached" } });
    expect(describeSealedServerAccess("m1", devicesStatus([phone("iPhone", [failed])]), null)).toEqual({
      text: "failed: it couldn't be reached",
      canRetry: true,
      isProblem: true,
    });
    const two = devicesStatus([phone("iPhone", [onServer()]), phone("iPad", [failed])]);
    expect(describeSealedServerAccess("m1", two, null).text).toBe("1/2 phones ready — iPad: it couldn't be reached");
  });

  it("says to update a daemon too old for encrypted phones", () => {
    const old = onServer({ generation: null, last_outcome: { kind: "daemon_too_old" } });
    expect(describeSealedServerAccess("m1", devicesStatus([phone("iPhone", [old])]), null)).toEqual({
      text: "daemon too old — update flightdeckd",
      canRetry: true,
      isProblem: true,
    });
  });

  it("surfaces a sync that could not run while a phone is still not set up — not once all are ready", () => {
    const pending = devicesStatus([phone("iPhone", [onServer({ generation: null })])], { sync_error: "no ssh key" });
    expect(describeSealedServerAccess("m1", pending, null)).toEqual({
      text: "couldn't set up: no ssh key",
      canRetry: true,
      isProblem: true,
    });
    const ready = devicesStatus([phone("iPhone", [onServer()])], { sync_error: "no ssh key" });
    expect(describeSealedServerAccess("m1", ready, null).isProblem).toBe(false);
  });
});

describe("describeProvisionStatus", () => {
  it("reports 'not checked yet' when there is no entry for this machine", () => {
    const label = describeProvisionStatus(undefined, NOW);
    expect(label).toEqual({ text: "not checked yet", canRetry: true, isProblem: false });
  });

  it("formats a provisioned row with a relative timestamp, not as a problem", () => {
    const label = describeProvisionStatus(
      { machine_id: "m1", state: { kind: "provisioned", at_ms: NOW - 5 * 60_000 }, checked_at_ms: NOW },
      NOW,
    );
    expect(label.text).toBe("provisioned 5 min ago");
    expect(label.isProblem).toBe(false);
    expect(label.canRetry).toBe(true);
  });

  it("shows pending as in-flight and NOT retryable (a retry is already running)", () => {
    const label = describeProvisionStatus(
      { machine_id: "m1", state: { kind: "pending" }, checked_at_ms: NOW },
      NOW,
    );
    expect(label).toEqual({ text: "pending…", canRetry: false, isProblem: false });
  });

  it("surfaces the daemon's own refusal reason verbatim, as a problem", () => {
    const label = describeProvisionStatus(
      {
        machine_id: "m1",
        state: { kind: "failed", reason: "too many authorized phones (max 32) — remove one first" },
        checked_at_ms: NOW,
      },
      NOW,
    );
    expect(label.text).toBe("failed: too many authorized phones (max 32) — remove one first");
    expect(label.isProblem).toBe(true);
    expect(label.canRetry).toBe(true);
  });

  it("names a too-old daemon distinctly from a generic failure", () => {
    const label = describeProvisionStatus(
      { machine_id: "m1", state: { kind: "daemon_too_old" }, checked_at_ms: NOW },
      NOW,
    );
    expect(label.text).toBe("daemon too old — update flightdeckd");
    expect(label.isProblem).toBe(true);
    expect(label.canRetry).toBe(true);
  });
});

describe("describeRevokeStatus", () => {
  it("returns null (nothing to show) when no revoke was ever attempted against this machine", () => {
    expect(describeRevokeStatus(undefined, NOW)).toBeNull();
  });

  it("confirms a removed old token, not as a problem", () => {
    const label = describeRevokeStatus(
      { machine_id: "m1", outcome: { kind: "removed" }, checked_at_ms: NOW - 60_000 },
      NOW,
    );
    expect(label?.text).toBe("old access revoked 1 min ago");
    expect(label?.isProblem).toBe(false);
    expect(label?.canRetry).toBe(false);
  });

  it("flags an unreachable server as a problem, without offering its own retry button", () => {
    const label = describeRevokeStatus(
      { machine_id: "m1", outcome: { kind: "queued" }, checked_at_ms: NOW },
      NOW,
    );
    expect(label?.text).toBe("old access: server unreachable — will revoke automatically once it's back");
    expect(label?.isProblem).toBe(true);
    expect(label?.canRetry).toBe(false);
  });

  it("surfaces a daemon's own revoke refusal reason verbatim, as a problem", () => {
    const label = describeRevokeStatus(
      { machine_id: "m1", outcome: { kind: "failed", reason: "disk full" }, checked_at_ms: NOW },
      NOW,
    );
    expect(label?.text).toBe("old access: revoke failed: disk full");
    expect(label?.isProblem).toBe(true);
  });

  it("names a too-old daemon distinctly from a generic revoke failure", () => {
    const label = describeRevokeStatus(
      { machine_id: "m1", outcome: { kind: "daemon_too_old" }, checked_at_ms: NOW },
      NOW,
    );
    expect(label?.text).toBe("old access: daemon too old to revoke — update flightdeckd");
    expect(label?.isProblem).toBe(true);
  });
});
