// What a paired phone can still reach once this Mac lets go of something — the
// warnings the security review (2026-10-09) asked for, kept pure (and tested) apart
// from the cards that show them:
//  - M10: removing a server that could not confirm it dropped this Mac's phone pairing.
//  - M11: turning remote access off disconnects THIS Mac only; every paired server keeps
//    its own relay connection and keeps answering a phone that is already paired.
// While the legacy (unencrypted, shared) pairing is in use, both offer "Retire legacy
// pairing" — the one action that makes it useless on this Mac and on every server
// (withdrawn, in the background, from each of them). It can no longer be regenerated:
// no legacy QR is shown anywhere, so a regenerated token could reach no phone and would
// only keep the unencrypted path open.
import { commands, type MachineRemoval } from "../../ipc/client";

/** The warning for a removed server that may still accept this Mac's phone pairing, or
 *  `null` when there is nothing to warn about (withdrawn, or never there). */
export function removalPhoneWarning(label: string, removal: MachineRemoval | null): string | null {
  const outcome = removal?.phone_revoke;
  const devices = removal?.devices_unconfirmed ?? 0;
  const phones =
    devices > 0
      ? `It also hasn't confirmed forgetting ${devices === 1 ? "an encrypted phone" : `${devices} encrypted phones`}: ` +
        `until it does, ${devices === 1 ? "that phone" : "those phones"} can still reach that server (and only it). `
      : "";
  if (!outcome || outcome.kind === "removed") {
    if (!phones) return null;
    return `“${label}” was removed. ${phones}Flight Deck keeps trying on its own, every few minutes and each time it starts.`;
  }
  const why =
    outcome.kind === "queued"
      ? "it couldn't be reached"
      : outcome.kind === "daemon_too_old"
        ? "its flightdeckd is too old to withdraw it"
        : `it refused: ${outcome.reason}`;
  return (
    `“${label}” was removed, but its phone access couldn't be withdrawn — ${why}. That server still holds ` +
    `your phone pairing: anyone who gets into it could use it to reach this Mac and your other servers. ${phones}` +
    `Flight Deck keeps trying on its own, every few minutes and each time it starts; retiring the legacy pairing ` +
    `makes that copy useless right away (phones still on it then pair again, encrypted).`
  );
}

/** The notice shown once remote access is turned off while servers are paired, or
 *  `null` without any — the switch only disconnects this Mac. A lost phone is revoked
 *  on its own (Settings → Phones); the legacy shared pairing, while still in use, can
 *  only be retired as a whole. */
export function remoteOffNotice(pairedServers: number, legacyActive: boolean): string | null {
  if (pairedServers <= 0) return null;
  const servers =
    pairedServers === 1
      ? "Your paired server keeps its own connection to the relay, so a phone that's already paired can still reach it."
      : `Your ${pairedServers} paired servers keep their own connection to the relay, so a phone that's already paired can still reach them.`;
  const legacy = legacyActive
    ? " A phone still on the legacy pairing can only be cut off by retiring that pairing — every phone on it then pairs again, encrypted."
    : "";
  return (
    `Remote access is off for this Mac only. ${servers} If you're turning it off because a phone was lost, turn ` +
    `access back on and revoke that phone in the Phones list: it then loses access everywhere.${legacy}`
  );
}

/** Said once "Retire legacy pairing" went through from one of these notices. */
export const LEGACY_RETIRED =
  "Legacy pairing retired — it no longer works on this Mac, and is being withdrawn from your servers. Pair your phones again in the Phones list (encrypted).";

/** "Retire legacy pairing" from a warning: the same call as the Phones list's own Retire
 *  button (revoked on the relay and on every server, never minted again). Works with
 *  remote access on or off. */
export async function retireLegacyPhonePairing(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await commands.retireLegacyPairing();
    return res.status === "ok" ? { ok: true } : { ok: false, error: res.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
