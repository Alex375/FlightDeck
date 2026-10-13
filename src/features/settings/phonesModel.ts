// What Settings says about each phone paired on the sealed channel
// (`docs/tarmac-sealed-channel.md` §7) — kept pure, and tested, apart from the panel
// that shows it (`PhonesPanel.tsx`). Every line names the server or the date it is
// about, and every problem says what to do about it.
import type { DeviceServerView, PendingDeviceRemoval, RemoteDeviceView } from "../../ipc/client";

/** A line of the panel, flagged when it needs the user's attention. */
export interface Line {
  text: string;
  problem: boolean;
}

const DAY = 24 * 3600 * 1000;

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "2 min ago", "3 h ago", "5 days ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** When the phone last reached THIS Mac over the encrypted channel. */
export function describeLastSeen(device: RemoteDeviceView, now: number): string {
  return device.last_seen_at === null ? "Not connected yet" : `Last connected ${ago(device.last_seen_at, now)}`;
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

/** One server's line for a phone. */
export function describeDeviceServer(server: DeviceServerView, newestGeneration: number): Line {
  const outcome = server.last_outcome;
  if (outcome?.kind === "daemon_too_old") {
    return { text: `${server.machine_label}: update its flightdeckd to reach it from this phone`, problem: true };
  }
  if (server.generation !== null && server.generation >= newestGeneration) {
    return { text: `${server.machine_label}: ready`, problem: false };
  }
  if (outcome?.kind === "failed") {
    return { text: `${server.machine_label}: not set up yet — ${outcome.reason}`, problem: true };
  }
  return { text: `${server.machine_label}: setting up…`, problem: false };
}

/** A revoked phone a server has not confirmed forgetting yet. */
export function describePendingRemoval(removal: PendingDeviceRemoval): Line {
  const why = removal.last_outcome?.kind === "failed" ? ` (${removal.last_outcome.reason})` : "";
  return {
    text: `A revoked phone is still being removed from ${removal.machine_label}${why}. Flight Deck keeps trying on its own.`,
    problem: true,
  };
}

/** Whether any line asks for a retry to be offered. */
export function needsRetry(devices: RemoteDeviceView[], pending: PendingDeviceRemoval[]): boolean {
  return (
    pending.length > 0 ||
    devices.some((d) => d.servers.some((s) => describeDeviceServer(s, d.generation).problem))
  );
}
