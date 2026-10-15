// What Settings says about each phone paired on the sealed channel
// (`docs/tarmac-sealed-channel.md` §7) — kept pure, and tested, apart from the panel
// that shows it (`PhonesPanel.tsx`). Every line names the server or the date it is
// about, and every problem says what to do about it.
import type {
  CleartextServer,
  DeviceServerView,
  PendingDeviceRemoval,
  RemoteDevicesStatus,
  RemoteDeviceView,
} from "../../ipc/client";
import { fmtAgo } from "../../ui/planUsageFormat";

/** A line of the panel, flagged when it needs the user's attention. */
export interface Line {
  text: string;
  problem: boolean;
}

const DAY = 24 * 3600 * 1000;

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** When the phone last reached THIS Mac over the encrypted channel. */
export function describeLastSeen(device: RemoteDeviceView, now: number): string {
  const when = device.last_seen_at === null ? null : fmtAgo(device.last_seen_at, now);
  return when === null ? "Not connected yet" : `Last connected ${when}`;
}

/** The key's lifetime: renewed on its own while the phone keeps reaching this Mac;
 *  flagged in its last week, and once expired. */
export function describeKey(device: RemoteDeviceView, now: number): Line {
  if (now >= device.expires_at) {
    return { text: "Its key has expired — pair this phone again.", problem: true };
  }
  const left = Math.ceil((device.expires_at - now) / DAY);
  if (left <= 7) {
    return {
      text: `Its key expires in ${left} day${left === 1 ? "" : "s"} — open the phone app while this Mac is online to renew it.`,
      problem: true,
    };
  }
  return { text: `Key renews on its own · valid until ${shortDate(device.expires_at)}`, problem: false };
}

/** Where one phone stands on one server — the single classification both the Phones
 *  panel (per phone) and each server's card (per server, `describeSealedServerAccess`)
 *  read, so the two never disagree. */
export type DeviceServerState =
  | { kind: "daemon_too_old" }
  | { kind: "ready" }
  | { kind: "failed"; reason: string }
  | { kind: "setting_up" };

export function deviceServerState(server: DeviceServerView, newestGeneration: number): DeviceServerState {
  const outcome = server.last_outcome;
  if (outcome?.kind === "daemon_too_old") return { kind: "daemon_too_old" };
  if (server.generation !== null && server.generation >= newestGeneration) return { kind: "ready" };
  if (outcome?.kind === "failed") return { kind: "failed", reason: outcome.reason };
  return { kind: "setting_up" };
}

/** One server's line for a phone. */
export function describeDeviceServer(server: DeviceServerView, newestGeneration: number): Line {
  const state = deviceServerState(server, newestGeneration);
  switch (state.kind) {
    case "daemon_too_old":
      return { text: `${server.machine_label}: update its flightdeckd to reach it from this phone`, problem: true };
    case "ready":
      return { text: `${server.machine_label}: ready`, problem: false };
    case "failed":
      return { text: `${server.machine_label}: not set up yet — ${state.reason}`, problem: true };
    case "setting_up":
      return { text: `${server.machine_label}: setting up…`, problem: false };
  }
}

/** A revoked phone a server has not confirmed forgetting yet. */
export function describePendingRemoval(removal: PendingDeviceRemoval): Line {
  const why = removal.last_outcome?.kind === "failed" ? ` (${removal.last_outcome.reason})` : "";
  return {
    text: `A revoked phone is still being removed from ${removal.machine_label}${why}. Flight Deck keeps trying on its own.`,
    problem: true,
  };
}

/** Servers that still hold the retired legacy pairing: they may still take unencrypted
 *  frames — which the relay could forge — until they confirm removing it. */
export function describeLegacyOwed(labels: string[]): Line | null {
  if (labels.length === 0) return null;
  const one = labels.length === 1;
  return {
    text:
      `${labels.join(", ")} still ${one ? "holds" : "hold"} the retired unencrypted pairing and may accept ` +
      `unencrypted connections until ${one ? "it is" : "they are"} reached. Flight Deck keeps trying on its own — ` +
      `turn ${one ? "it" : "them"} on to finish.`,
    problem: true,
  };
}

/** A server whose RUNNING daemon still carries out unencrypted commands — which the
 *  relay could forge — named, with why and what to do. */
export function describeCleartextServer(server: CleartextServer): Line {
  return { text: `${server.machine_label} still accepts unencrypted commands: ${server.reason}.`, problem: true };
}

/** Whether any line asks for a retry to be offered. */
export function needsRetry(status: RemoteDevicesStatus | null): boolean {
  if (!status) return false;
  return (
    status.pending_removals.length > 0 ||
    status.legacy_revocations_owed.length > 0 ||
    status.sync_error !== null ||
    status.cleartext_servers.length > 0 ||
    status.devices.some((d) => d.servers.some((s) => describeDeviceServer(s, d.generation).problem))
  );
}
