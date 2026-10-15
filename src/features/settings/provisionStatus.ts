// Pure formatting for the per-server phone-provisioning status row (C10/C11) —
// kept separate from ControlSection.tsx so it's unit-testable without mounting
// React, the same split as `parseTicket`/`buildServerCommand` in that file.
import type {
  MachineProvisionStatus,
  MachineRevokeStatus,
  ProvisionState,
  RemoteDevicesStatus,
  RemoteStatus,
} from "../../ipc/client";
import { timeAgo } from "../history/historyView";
import { deviceServerState } from "./phonesModel";

/** What a status row shows, plus whether it's worth offering a Retry button. */
export interface ProvisionStatusLabel {
  /** The row's status text (e.g. "provisioned 3 min ago", "failed: …"). */
  text: string;
  /** Whether a Retry button makes sense here — everything except a live "pending". */
  canRetry: boolean;
  /** Render with the danger/warning treatment (failed / daemon too old). */
  isProblem: boolean;
}

/**
 * Describes one machine's phone-provisioning status for display, or the
 * "never attempted this run" case when `phone_provisioning_status` has no
 * entry for it yet (a fresh launch, or remote access has never been on) —
 * not a failure, just nothing to report.
 */
export function describeProvisionStatus(
  status: MachineProvisionStatus | undefined,
  nowMs: number,
): ProvisionStatusLabel {
  if (!status) {
    return { text: "not checked yet", canRetry: true, isProblem: false };
  }
  return describeProvisionState(status.state, nowMs);
}

function describeProvisionState(state: ProvisionState, nowMs: number): ProvisionStatusLabel {
  switch (state.kind) {
    case "provisioned":
      return { text: `provisioned ${timeAgo(state.at_ms, nowMs)}`, canRetry: true, isProblem: false };
    case "pending":
      return { text: "pending…", canRetry: false, isProblem: false };
    case "failed":
      return { text: `failed: ${state.reason}`, canRetry: true, isProblem: true };
    case "daemon_too_old":
      return { text: "daemon too old — update flightdeckd", canRetry: true, isProblem: true };
  }
}

const CHECKING: ProvisionStatusLabel = { text: "checking…", canRetry: false, isProblem: false };

/**
 * A server card's "phone access" line. While the legacy shared pairing is in use it
 * reports that token's provisioning (`describeProvisionStatus`); once it is retired
 * that token is never provisioned again — the row would sit on "not checked yet" and
 * its Retry could only answer "nothing to provision" — so it reports the phones paired
 * on the encrypted channel instead (`describeSealedServerAccess`). `null` remote =
 * not read yet: which of the two applies is unknown.
 */
export function describeServerPhoneAccess(
  machineId: string,
  remote: RemoteStatus | null,
  legacy: MachineProvisionStatus | undefined,
  devices: RemoteDevicesStatus | null,
  devicesError: string | null,
  nowMs: number,
): ProvisionStatusLabel {
  if (remote === null) return CHECKING;
  if (remote.legacy_active) return describeProvisionStatus(legacy, nowMs);
  return describeSealedServerAccess(machineId, devices, devicesError);
}

/**
 * Where the phones paired on the encrypted channel stand on ONE server, folded into
 * one line: ready, still being set up, or what stops them (with Retry). Reads the same
 * per-phone classification as the Phones panel (`deviceServerState`). Not gated on
 * remote access being on: turning it off disconnects this Mac only, the servers keep
 * answering the phones they hold keys for.
 */
export function describeSealedServerAccess(
  machineId: string,
  devices: RemoteDevicesStatus | null,
  devicesError: string | null,
): ProvisionStatusLabel {
  if (devicesError !== null) {
    return { text: `couldn't read the paired phones: ${devicesError}`, canRetry: false, isProblem: true };
  }
  if (devices === null) return CHECKING;
  const phones = devices.devices.map((d) => {
    const entry = d.servers.find((s) => s.machine_id === machineId);
    // A server paired after the last read-back has no entry yet: the sync that pairing
    // a server starts is what sets it up.
    return { label: d.label, state: entry ? deviceServerState(entry, d.generation) : { kind: "setting_up" as const } };
  });
  const n = phones.length;
  if (n === 0) return { text: "no phone paired", canRetry: false, isProblem: false };
  const ready = phones.filter((p) => p.state.kind === "ready").length;
  if (phones.some((p) => p.state.kind === "daemon_too_old")) {
    return { text: "daemon too old — update flightdeckd", canRetry: true, isProblem: true };
  }
  const failed = phones.find((p) => p.state.kind === "failed");
  if (failed && failed.state.kind === "failed") {
    const why = failed.state.reason;
    return {
      text: n === 1 ? `failed: ${why}` : `${ready}/${n} phones ready — ${failed.label}: ${why}`,
      canRetry: true,
      isProblem: true,
    };
  }
  if (ready === n) {
    return { text: n === 1 ? `ready (${phones[0].label})` : `ready on ${n} phones`, canRetry: false, isProblem: false };
  }
  if (devices.sync_error !== null) {
    return { text: `couldn't set up: ${devices.sync_error}`, canRetry: true, isProblem: true };
  }
  return {
    text: n === 1 ? "setting up…" : `${ready}/${n} phones ready, setting up the rest…`,
    canRetry: false,
    isProblem: false,
  };
}

/**
 * Describes one machine's phone-REVOCATION status (the "did the OLD token
 * actually get forgotten here" row, C10's critical fix) — `null` when
 * `phone_revocation_status` has no entry for it, which just means no
 * revocation was ever attempted against this machine this run (the common
 * case: a revoke only runs when the user regenerates pairing) — nothing to
 * show, not a problem. Unlike provisioning there is no dedicated retry
 * action: an unreachable/refused/too-old daemon is retried automatically the
 * next time it's successfully contacted (including as a side effect of the
 * provisioning "Retry" button above it), so this never offers its own button.
 */
export function describeRevokeStatus(
  status: MachineRevokeStatus | undefined,
  nowMs: number,
): ProvisionStatusLabel | null {
  if (!status) return null;
  switch (status.outcome.kind) {
    case "removed":
      return { text: `old access revoked ${timeAgo(status.checked_at_ms, nowMs)}`, canRetry: false, isProblem: false };
    case "queued":
      return {
        text: "old access: server unreachable — will revoke automatically once it's back",
        canRetry: false,
        isProblem: true,
      };
    case "daemon_too_old":
      return { text: "old access: daemon too old to revoke — update flightdeckd", canRetry: false, isProblem: true };
    case "failed":
      return { text: `old access: revoke failed: ${status.outcome.reason}`, canRetry: false, isProblem: true };
  }
}
