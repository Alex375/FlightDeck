// What is wrong between this Mac and a paired server, as every server surface says it — the
// remote mark, the composer's band, the side panel's Machine row, the TOSSE place picker — so
// none of them can tell it differently. Pure.
//
// Two rules the surfaces used to break:
//  - THIS MAC OFFLINE IS NOT THE SERVER'S FAULT. A probe or a dial runs FROM this Mac: with no
//    network at all, every server reads "unreachable" — an accusation that sends the user to
//    diagnose a server that is fine. Offline outranks any verdict, and is said as the Mac's.
//  - A VERDICT SAYS HOW OLD IT IS. "Unreachable" from a check five minutes ago is not news of
//    now; the age is part of the fact, everywhere it is shown.
import { isUnreachable, type MachineHealth } from "../../store/machineHealth";

/** "4 min ago" / "just now" for the last moment we know the machine answered. `null` when it
 *  has never answered in this app run — which the caller renders as its own sentence rather
 *  than as a fake duration. */
export function lastReachedPhrase(health: MachineHealth, nowMs: number): string | null {
  if (health.lastReachedAtMs === null) return null;
  const secs = Math.max(0, Math.round((nowMs - health.lastReachedAtMs) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "just now" / "4 min ago" for a verdict's age. Same wording (and the same clock-skew clamp)
 *  as "last reached" — one voice for time across the machine surfaces. */
export function checkedPhrase(health: MachineHealth, nowMs: number): string {
  return lastReachedPhrase({ ...health, lastReachedAtMs: health.checkedAtMs }, nowMs) ?? "just now";
}

export type ServerFault =
  /** This Mac has no network: nothing can reach the server from here, whatever it is doing. */
  | { kind: "macOffline" }
  /** Checked and found out of reach — `checked` is how long ago, `lastReached` since when it
   *  has been gone (`null`: not once since the app started). */
  | { kind: "unreachable"; reason: string | null; checked: string; lastReached: string | null };

/** What is wrong right now, or `null` when nothing is known to be (no verdict is not a fault). */
export function serverFault(
  health: MachineHealth | undefined,
  { online, nowMs }: { online: boolean; nowMs: number },
): ServerFault | null {
  if (!online) return { kind: "macOffline" };
  if (!health || !isUnreachable(health)) return null;
  return {
    kind: "unreachable",
    reason: health.reason,
    checked: checkedPhrase(health, nowMs),
    lastReached: lastReachedPhrase(health, nowMs),
  };
}

/** The offline sentence, about one server. */
export function macOfflineDetail(name: string): string {
  return `${name} can't be reached from here until the network is back`;
}

/** "Last reached 4 min ago" / "Not reached since the app started" — WHEN tells a server that
 *  just fell over from one that was already gone when you sat down. */
export function lastReachedLine(lastReached: string | null): string {
  return lastReached ? `Last reached ${lastReached}` : "Not reached since the app started";
}
