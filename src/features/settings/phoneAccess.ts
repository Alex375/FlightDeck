// What a paired phone can still reach once this Mac lets go of something — the
// warnings the security review (2026-10-09) asked for, kept pure (and tested) apart
// from the cards that show them:
//  - M10: removing a server that could not confirm it dropped this Mac's phone pairing.
//  - M11: turning remote access off disconnects THIS Mac only; every paired server keeps
//    its own relay connection and keeps answering a phone that is already paired.
// Both offer "Regenerate pairing" — the one action that makes the old pairing useless
// on this Mac and on every server still reachable (it is also withdrawn, in the
// background, from each of them).
import { commands, type MachineRemoval } from "../../ipc/client";

/** The warning for a removed server that may still accept this Mac's phone pairing, or
 *  `null` when there is nothing to warn about (withdrawn, or never there). */
export function removalPhoneWarning(label: string, removal: MachineRemoval | null): string | null {
  const outcome = removal?.phone_revoke;
  if (!outcome || outcome.kind === "removed") return null;
  const why =
    outcome.kind === "queued"
      ? "it couldn't be reached"
      : outcome.kind === "daemon_too_old"
        ? "its flightdeckd is too old to withdraw it"
        : `it refused: ${outcome.reason}`;
  return (
    `“${label}” was removed, but its phone access couldn't be withdrawn — ${why}. That server still holds ` +
    `your phone pairing: anyone who gets into it could use it to reach this Mac and your other servers. ` +
    `Flight Deck keeps trying each time it starts; regenerating the pairing makes that copy useless right ` +
    `away (your phone then needs the new QR).`
  );
}

/** The notice shown once remote access is turned off while servers are paired, or
 *  `null` without any — the switch only disconnects this Mac. */
export function remoteOffNotice(pairedServers: number): string | null {
  if (pairedServers <= 0) return null;
  const servers =
    pairedServers === 1
      ? "Your paired server keeps its own connection to the relay, so a phone that's already paired can still reach it."
      : `Your ${pairedServers} paired servers keep their own connection to the relay, so a phone that's already paired can still reach them.`;
  return (
    `Remote access is off for this Mac only. ${servers} If you're turning it off because a phone was lost or its ` +
    `pairing was shared, regenerate the pairing — every phone then needs the new QR.`
  );
}

/** Said once "Regenerate pairing" went through from one of these notices. */
export const PAIRING_REGENERATED =
  "Pairing regenerated — the old one no longer works on this Mac, and is being withdrawn from your servers. Pair your phone again from its new QR.";

/** "Regenerate pairing" from a warning: the same `set_remote` call as the Remote access
 *  card's own Regenerate button (a fresh token, the old one revoked on the relay and on
 *  every server it reached). Works with remote access on or off. */
export async function regeneratePhonePairing(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await commands.setRemote(null, null, true, null);
    return res.status === "ok" ? { ok: true } : { ok: false, error: res.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
