// The server-identity check shown before Flight Deck trusts a server's host key
// (security review 2026-10-09, M12 / I6): the fingerprint the server presents right now
// — read by `bootstrap_check_host_key`, no secret sent — next to what this Mac saved,
// with the command that prints the real one on the server's own console. Nothing is
// trusted until the user confirms; Cancel leaves no key saved anywhere.
import type { HostKeyCheck } from "../../ipc/client";
import { hostKeyConsoleCommand } from "./serverBootstrapModel";
import sharedStyles from "./SettingsPanel.module.css";
import wStyles from "./ServerBootstrapWizard.module.css";

/** `password`: the wizard is about to send this server a login password.
 *  `connect`: a keyed connection ("Connect an existing server"). */
export type HostKeyReviewPurpose = "password" | "connect";

export function HostKeyReview({
  check,
  purpose,
  busy,
  onConfirm,
  onCancel,
}: {
  check: HostKeyCheck;
  purpose: HostKeyReviewPurpose;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const changed = check.trust === "changed";
  // Saved on this Mac, but no paired server vouches for it (a connection that never
  // logged in may have saved it): checked exactly like a first contact.
  const unverified = check.trust === "unverified";
  const where = check.port === 22 ? check.host : `${check.host}:${check.port}`;
  return (
    <div className={wStyles.actionPanel} role="group" aria-label="Server identity check">
      {changed ? (
        <div>
          <b>{where}</b> presents a different identity (host key) than the one this Mac saved. If that&apos;s
          expected — a reinstall, a new machine at that address — check the new fingerprint on the server itself
          before trusting it. If it isn&apos;t, someone may be intercepting the connection: keep the old key.
        </div>
      ) : purpose === "password" ? (
        <div>
          {unverified ? (
            <>
              <b>{where}</b> isn&apos;t paired with this Mac yet, and the identity (host key) saved for it was never
              confirmed.
            </>
          ) : (
            <>
              First connection to <b>{where}</b>.
            </>
          )}{" "}
          Before your password is sent, check that this really is your server: on its own console — not over this
          connection — run the command below and compare the fingerprint it prints.
        </div>
      ) : (
        <div>
          {unverified ? (
            <>
              The identity (host key) this Mac saved for <b>{where}</b> was never confirmed.
            </>
          ) : (
            <>
              This Mac has no saved identity (host key) for <b>{where}</b>.
            </>
          )}{" "}
          Check it on the server&apos;s own console before trusting it.
        </div>
      )}
      {changed &&
        check.saved_fingerprints.map((fp) => (
          <div key={fp}>
            Saved on this Mac: <span className={sharedStyles.mono}>{fp}</span>
          </div>
        ))}
      <div>
        {changed ? "Presented now" : "Presented"}:{" "}
        <span className={sharedStyles.mono}>
          {check.key_type} {check.fingerprint}
        </span>
      </div>
      <pre className={sharedStyles.codeBlock}>{hostKeyConsoleCommand(check.key_type)}</pre>
      <div className={sharedStyles.btnRow}>
        <button className={`${sharedStyles.btn} ${sharedStyles.primary}`} disabled={busy} onClick={onConfirm}>
          {changed ? "Trust the new key and retry" : purpose === "password" ? "It matches — continue" : "It matches — trust it"}
        </button>
        <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} disabled={busy} onClick={onCancel}>
          {changed ? "Keep the old key" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
