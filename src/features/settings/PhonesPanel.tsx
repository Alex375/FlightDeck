// Settings → Remote access → Phones: the phones paired on the encrypted channel
// (`docs/tarmac-sealed-channel.md`), one row each — when it last connected, its key's
// lifetime, where it stands on every paired server — with Revoke per phone, "Pair a
// phone" (its QR shown once: it carries the phone's key), and while the legacy shared
// pairing is still in use, the warning and the Retire button that closes it.
import { useCallback, useEffect, useState } from "react";
import {
  commands,
  type PairedDevice,
  type RemoteDevicesStatus,
  type RemoteDeviceView,
  type RemoteStatus,
} from "../../ipc/client";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useNow } from "../../ui/useNow";
import {
  describeCleartextServer,
  describeDeviceServer,
  describeKey,
  describeLastSeen,
  describeLegacyOwed,
  describePendingRemoval,
  needsRetry,
} from "./phonesModel";
import styles from "./SettingsPanel.module.css";

type Confirm = { kind: "revoke"; device: RemoteDeviceView } | { kind: "retire" } | null;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function PhonesPanel({ remote, onRemote }: { remote: RemoteStatus; onRemote: (s: RemoteStatus) => void }) {
  const now = useNow(30_000);
  const [status, setStatus] = useState<RemoteDevicesStatus | null>(null);
  // An action's failure (pair, revoke, retire, retry) stays until the next action; a
  // failed read-back is its own line, cleared by the next read that succeeds.
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [paired, setPaired] = useState<PairedDevice | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      const res = await commands.listRemoteDevices();
      if (res.status === "ok") {
        setStatus(res.data);
        setReadError(null);
      } else {
        setReadError(`Couldn't read the paired phones: ${res.error}`);
      }
    } catch (e) {
      setReadError(`Couldn't read the paired phones: ${message(e)}`);
    }
  }, []);

  useEffect(() => {
    void read();
    const id = setInterval(() => void read(), 4000);
    return () => clearInterval(id);
  }, [read]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
        void read();
      }
    },
    [read],
  );

  const pair = () =>
    run(async () => {
      const res = await commands.pairRemoteDevice(draft ?? "");
      if (res.status === "error") throw new Error(res.error);
      setDraft(null);
      setPaired(res.data);
    });

  const revoke = (device: RemoteDeviceView) =>
    run(async () => {
      const res = await commands.revokeRemoteDevice(device.device_id);
      if (res.status === "error") throw new Error(res.error);
      setConfirm(null);
    });

  const retire = () =>
    run(async () => {
      const res = await commands.retireLegacyPairing();
      if (res.status === "error") throw new Error(res.error);
      onRemote(res.data);
      setConfirm(null);
    });

  const retry = () =>
    run(async () => {
      const res = await commands.retryDeviceProvisioning();
      if (res.status === "error") throw new Error(res.error);
      setStatus(res.data);
    });

  // The link carries the phone's pairing key: it is cleared from the clipboard after a
  // minute if it is still what the clipboard holds (never clobbering a later copy).
  const copyLink = async () => {
    if (!paired) return;
    const link = paired.pairing_url;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      setTimeout(() => {
        void navigator.clipboard
          .readText()
          .then((now) => (now === link ? navigator.clipboard.writeText("") : undefined))
          .catch(() => {
            /* reading the clipboard refused: leave it (the key expires within a day anyway) */
          });
      }, 60_000);
    } catch {
      setError("Couldn't copy the link — the clipboard was refused.");
    }
  };

  const devices = status?.devices ?? [];
  const pending = status?.pending_removals ?? [];
  const legacyOwed = describeLegacyOwed(status?.legacy_revocations_owed ?? []);
  const cleartext = (status?.cleartext_servers ?? []).map(describeCleartextServer);
  const retryOffered = needsRetry(status);

  return (
    <>
      {remote.legacy_active && (
        <div className={styles.remotePanel} role="note">
          <div className={styles.remoteStep}>
            <b>Legacy pairing (unencrypted).</b> Phones paired before encryption still share one link that is not
            encrypted end to end: the relay in between can read their messages and could forge commands to this Mac
            and your servers. Pair each phone again below, then retire it.
          </div>
          <div className={styles.btnRow}>
            <button
              className={`${styles.btn} ${styles.danger}`}
              disabled={busy}
              onClick={() => setConfirm({ kind: "retire" })}
            >
              Retire legacy pairing
            </button>
          </div>
        </div>
      )}

      <div className={styles.remoteRow}>
        <div className={styles.remoteMain}>
          <span className={styles.remoteName}>Phones</span>
          <span className={styles.remoteStatusText}>
            End-to-end encrypted: the relay only routes ciphertext. Each phone has its own key, on this Mac and on
            each server.
          </span>
        </div>
        {draft === null && !paired && (
          <button className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => setDraft("")}>
            Pair a phone
          </button>
        )}
      </div>

      {draft !== null && (
        <div className={styles.remotePanel}>
          <div className={styles.remoteStep}>Name this phone — it's how it shows up here and on your servers.</div>
          <div className={styles.fieldRow}>
            <input
              className={styles.field}
              autoFocus
              placeholder="e.g. Alex's iPhone"
              value={draft}
              maxLength={64}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void pair();
              }}
              aria-label="Name of this phone"
            />
            <button className={`${styles.btn} ${styles.primary}`} disabled={busy} onClick={() => void pair()}>
              {busy ? "Creating…" : "Create pairing code"}
            </button>
            <button className={`${styles.btn} ${styles.ghost}`} disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {paired && (
        <div className={styles.remotePanel}>
          <div className={styles.remoteStep}>
            Scan this with <b>{paired.label}</b>'s camera, or from the installed Tarmac app. It holds the phone's key, so
            it is shown only now — close it once the phone is paired, and keep it private. That key works once: the
            phone swaps it for its own as soon as it connects, and an unscanned code stops working within a day.
          </div>
          {paired.pairing_qr_svg ? (
            <div
              style={{ background: "#fff", padding: 12, borderRadius: 12, width: 190, height: 190, margin: "4px auto" }}
              dangerouslySetInnerHTML={{ __html: paired.pairing_qr_svg }}
            />
          ) : (
            <div className={styles.dangerText}>The QR couldn't be drawn — use Copy link instead.</div>
          )}
          <div className={styles.btnRow}>
            <button className={`${styles.btn} ${styles.ghost}`} onClick={() => void copyLink()}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <span className={styles.spacer} />
            <button
              className={`${styles.btn} ${styles.primary}`}
              onClick={() => {
                setPaired(null);
                setCopied(false);
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {status && devices.length === 0 && !paired && (
        <div className={styles.remoteEmpty}>No phone paired on the encrypted channel yet.</div>
      )}

      {devices.map((d) => {
        const key = describeKey(d, now);
        return (
          <div key={d.device_id} className={styles.remoteRow}>
            <div className={styles.remoteMain} style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
              <span className={styles.remoteName}>{d.label}</span>
              <span className={styles.remoteStatusText}>{describeLastSeen(d, now)}</span>
              <span className={key.problem ? styles.dangerText : styles.remoteStatusText}>{key.text}</span>
              {d.servers.map((s) => {
                const line = describeDeviceServer(s, d.generation);
                return (
                  <span key={s.machine_id} className={line.problem ? styles.dangerText : styles.remoteStatusText}>
                    {line.text}
                  </span>
                );
              })}
            </div>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              disabled={busy}
              onClick={() => setConfirm({ kind: "revoke", device: d })}
            >
              Revoke
            </button>
          </div>
        );
      })}

      {pending.map((r) => (
        <div key={`${r.device_id}/${r.machine_id}`} className={styles.remoteRow}>
          <span className={styles.dangerText}>{describePendingRemoval(r).text}</span>
        </div>
      ))}

      {legacyOwed && (
        <div className={styles.remoteRow}>
          <span className={styles.dangerText}>{legacyOwed.text}</span>
        </div>
      )}
      {cleartext.map((line) => (
        <div key={line.text} className={styles.remoteRow} role="note">
          <span className={styles.dangerText}>{line.text}</span>
        </div>
      ))}

      {(retryOffered || error || readError) && (
        <div className={styles.remoteFooter}>
          {error && <div className={styles.dangerText}>⚠️ {error}</div>}
          {readError && <div className={styles.dangerText}>⚠️ {readError}</div>}
          {status?.sync_error && (
            <div className={styles.dangerText}>⚠️ Couldn't bring the servers up to date: {status.sync_error}</div>
          )}
          {retryOffered && (
            <button className={`${styles.btn} ${styles.ghost}`} disabled={busy} onClick={() => void retry()}>
              {busy ? "Retrying…" : "Retry servers now"}
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm?.kind === "revoke"}
        title={confirm?.kind === "revoke" ? `Revoke ${confirm.device.label}?` : ""}
        confirmLabel="Revoke"
        danger
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === "revoke") void revoke(confirm.device);
        }}
      >
        It immediately loses access to this Mac and to your servers (each server forgets it as soon as it can be
        reached). To use it again, pair it anew.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "retire"}
        title="Retire the legacy pairing?"
        confirmLabel="Retire"
        danger
        busy={busy}
        size="lg"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void retire()}
      >
        Phones still using it lose access to this Mac and to your servers until you pair them again here. From then
        on, this Mac only accepts encrypted connections. A server does too once it runs flightdeckd 0.5 or later and
        no older pairing remains on it — any server that still doesn't is named here.
      </ConfirmDialog>
    </>
  );
}
