// "Connect an existing server" — the way in for a server Flight Deck's installer can't
// set up (a Mac, whose daemon is a hand-made LaunchAgent; or any box prepared by hand):
// type its SSH coordinates, `add_machine` checks over SSH that `claude` and a recent
// enough `flightdeckd` are there, and saves it. Nothing is installed or changed on the
// server. The installer wizard (`ServerBootstrapWizard`) stays the path for a fresh
// Linux box.
//
// Two ways to authenticate: this Mac's own SSH setup (`identity_file: null` — ~/.ssh
// keys, ~/.ssh/config, ssh-agent, exactly what `ssh user@host` would use), or a key
// Flight Deck mints and holds (this form's own pending key slot, `generate_connect_key`,
// claimed on success), authorized on the server with a one-line command. Every failure
// from the probe is shown as the backend words it — never swallowed, even once the form
// is gone (it then goes to the app banner), unless the user cancelled that attempt.
//
// A CHANGED host key (I6, security review 2026-10-09) is never replaced blind: "Review
// the new key" reads the key the server presents now (`bootstrap_check_host_key`, no
// secret sent) and shows it next to the saved one in `HostKeyReview`; only an explicit
// "Trust the new key and retry" swaps it (`bootstrap_forget_host_key` with that exact
// fingerprint — refused if the server then presents any other).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands, type GeneratedKey, type HostKeyCheck } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import { useConversationsStore, type Machine } from "../../store/conversationsStore";
import { buildAuthorizeKeyCommand } from "./ControlSection";
import { HostKeyReview } from "./HostKeyReview";
import { OptionCardRail } from "./SettingsKit";
import { isHostKeyRejected, isServerBusyError } from "./serverBootstrapModel";
import { firstConnectionFieldError } from "./sshValidation";
import sharedStyles from "./SettingsPanel.module.css";

type KeyMode = "mac" | "dedicated";

const KEY_MODES: ReadonlyArray<{ id: KeyMode; label: string; desc: string }> = [
  {
    id: "mac",
    label: "This Mac's SSH keys",
    desc: "Whatever ssh user@host already uses here — ~/.ssh keys, ~/.ssh/config, ssh-agent.",
  },
  {
    id: "dedicated",
    label: "A key for Flight Deck",
    desc: "Flight Deck makes its own key; you authorize it on the server once. Lets Flight Deck repair the server later.",
  },
];

/** What a successful connect reports besides the saved machine itself. */
export interface ConnectOutcome {
  /** It updated a server that was already listed rather than adding one. */
  matchedExisting: boolean;
  /** That server's Flight Deck key is no longer the one it uses —
   *  `AddMachineOutcome.previous_key_dropped`. */
  previousKeyDropped: boolean;
  /** "This Mac's SSH keys" was chosen, but the listed server kept its Flight Deck key:
   *  `add_machine` tries that key first, and it still got in. */
  keptFlightDeckKey: boolean;
}

/** {@link ConnectOutcome} of a save, given the identity the form SENT: a listed server
 *  saved with a key although none was sent kept its own Flight Deck key. */
export function connectOutcome(
  res: { machine: Machine; matchedExisting: boolean; previousKeyDropped: boolean },
  sentIdentityFile: string | null,
): ConnectOutcome {
  return {
    matchedExisting: res.matchedExisting,
    previousKeyDropped: res.previousKeyDropped,
    keptFlightDeckKey: res.matchedExisting && sentIdentityFile === null && res.machine.identityFile != null,
  };
}

/** Said whenever a server fell back to this Mac's own keys because Flight Deck's key for
 *  it stopped working — on its own, the server just quietly loses the repairs that need
 *  Flight Deck's key. */
const KEY_FELL_BACK =
  "Flight Deck's own key for it no longer worked, so it now uses this Mac's SSH keys — the repairs that need Flight Deck's key aren't offered until you reconnect it with “A key for Flight Deck”.";

/** The confirmation shown once the form has closed (`RemoteServersGroup`) — the new row
 *  alone is easy to miss, and an update shows no new row at all. A dropped Flight Deck
 *  key is always said, and flagged as a problem when the server fell back to this Mac's
 *  own keys: the repairs that need Flight Deck's key are no longer offered for it. A new
 *  Flight Deck key just takes the old one's place — usually its very file, overwritten
 *  on the spot, so nothing claims when the old one goes. */
export function connectedNotice(machine: Machine, outcome: ConnectOutcome): { text: string; isProblem: boolean } {
  const saved = outcome.matchedExisting
    ? `Updated the existing server “${machine.label}”.`
    : `Connected “${machine.label}” — it's listed above.`;
  if (outcome.keptFlightDeckKey && !outcome.previousKeyDropped) {
    // Said, or the user takes the switch to this Mac's keys as done — and removes the
    // key the server still logs in with.
    return {
      text: `${saved} It keeps using Flight Deck's own key, which still works for this server — not this Mac's SSH keys.`,
      isProblem: false,
    };
  }
  if (!outcome.previousKeyDropped) return { text: saved, isProblem: false };
  if (machine.identityFile) {
    return { text: `${saved} It now uses the new Flight Deck key in place of the old one.`, isProblem: false };
  }
  return { text: `${saved} ${KEY_FELL_BACK}`, isProblem: true };
}

/** How an attempt stopped reporting to its form: the user pressed Cancel, or the form
 *  closed under it (Settings closed, another tab or sub-tab opened) — then it still
 *  owes its outcome. */
export type LateHow = "cancelled" | "closed";

/** What a save that landed after its form was cancelled or closed must still say —
 *  `null` when nothing was lost. The server itself shows up in the list either way, but
 *  a fall-back to this Mac's keys (`KEY_FELL_BACK`) would otherwise pass in silence. */
export function lateConnectProblem(machine: Machine, outcome: ConnectOutcome, how: LateHow): string | null {
  const notice = connectedNotice(machine, outcome);
  if (!notice.isProblem) return null;
  const lead =
    how === "cancelled"
      ? `The connection to “${machine.label}” you cancelled went through anyway.`
      : `Connecting “${machine.label}” finished after the form was closed.`;
  return `${lead} ${KEY_FELL_BACK}`;
}

/** What a FAILED attempt whose form closed under it says on the app banner — nothing
 *  else would: the form that would have shown it is gone, and no server was saved. */
export function lateConnectFailure(target: SshTarget, message: string): string {
  const where = target.port === 22 ? target.host : `${target.host}:${target.port}`;
  return `Connecting ${where} failed after the “Connect an existing server” form was closed: ${message}`;
}

/** The SSH host and port one attempt dialed. */
export interface SshTarget {
  host: string;
  port: number;
}

/** A failed attempt, worded by the backend — and, when ssh refused a CHANGED host key,
 *  the host and port that were refused: "Review the new key" checks THOSE, never
 *  whatever the fields say by the time it is clicked. */
interface Failure {
  message: string;
  hostKeyTarget: SshTarget | null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ConnectExistingServerForm({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  /** The server was saved. Called at most once per attempt, and never once the form
   *  was closed or the attempt cancelled — a save that lands after that and lost Flight
   *  Deck's key is reported on the app banner instead (`lateConnectProblem`), and so is
   *  a failure once the form closed without a Cancel (`lateConnectFailure`). */
  onConnected: (machine: Machine, outcome: ConnectOutcome) => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [keyMode, setKeyMode] = useState<KeyMode>("mac");
  const [key, setKey] = useState<GeneratedKey | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // The changed host key awaiting the user's decision, with the host and port it was
  // read from (I6) — see the module doc.
  const [review, setReview] = useState<{ target: SshTarget; check: HostKeyCheck } | null>(null);

  // An attempt can outlive the form (Cancel unmounts it, and so does closing Settings or
  // opening another tab) and its late answer used to land anyway — a "connected" notice
  // for a form the user had closed. Only the LATEST attempt of a still-mounted form may
  // touch its state or report a save. (The server itself is saved either way: the store
  // lists it — and a late save that lost Flight Deck's key is still said, see
  // `lateConnectProblem`.) An attempt the user CANCELLED is dropped; one whose form
  // merely closed still owes its failure (`reportLateFailure`).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const attemptSeq = useRef(0);
  /** The latest attempt Cancel abandoned — every attempt up to it was cancelled. */
  const cancelledUpTo = useRef(0);
  const isCurrent = useCallback((attempt: number) => mounted.current && attempt === attemptSeq.current, []);
  const lateHow = useCallback(
    (attempt: number): LateHow => (attempt <= cancelledUpTo.current ? "cancelled" : "closed"),
    [],
  );
  /** A failure of an attempt that no longer reports to the form: on the app banner,
   *  unless the user cancelled it. */
  const reportLateFailure = useCallback(
    (attempt: number, target: SshTarget, message: string) => {
      if (lateHow(attempt) === "closed") useAppErrors.getState().pushError(lateConnectFailure(target, message));
    },
    [lateHow],
  );

  // The dedicated key is minted (or this form's pending one reused) the first time it's
  // chosen — never for someone who sticks with this Mac's keys.
  useEffect(() => {
    if (keyMode !== "dedicated" || key) return;
    let disposed = false;
    setKeyError(null);
    void useConversationsStore
      .getState()
      .generateConnectKey(name.trim() || address.trim() || "server")
      .then(
        (res) => {
          if (disposed) return;
          if (res.ok) setKey(res.key);
          else setKeyError(res.error);
        },
        (e: unknown) => {
          if (!disposed) setKeyError(errorMessage(e));
        },
      );
    return () => {
      disposed = true;
    };
    // `name`/`address` only seed the key's comment — re-minting on every keystroke
    // would be wrong, so they are deliberately not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyMode, key]);

  // Same rule as the wizard's form: validated only once something is typed, so a blank
  // form isn't greeted with an error — it just stays disabled.
  const fieldError = useMemo(() => {
    if (!address.trim() && !user.trim()) return null;
    return firstConnectionFieldError(user.trim(), address.trim(), Number(port) || 0);
  }, [address, user, port]);

  const authorizeCommand = key ? buildAuthorizeKeyCommand(key.public_key) : null;
  const canConnect =
    !connecting && !fieldError && !!address.trim() && !!user.trim() && (keyMode === "mac" || !!key);

  // The forget offer belongs to the host and port that were refused: editing either
  // withdraws it, with its error, rather than leave a button that would forget a host
  // the fields no longer name.
  const dropHostKeyFailure = useCallback(() => {
    setFailure((f) => (f?.hostKeyTarget ? null : f));
    setReview(null);
  }, []);

  /** One `add_machine` round trip against `target`, with the form's other fields. A
   *  blank Name is sent blank: the backend keeps a listed server's name, or names a
   *  new one after the address that worked. */
  const attemptConnect = useCallback(
    async (attempt: number, target: SshTarget) => {
      const identityFile = keyMode === "dedicated" && key ? key.identity_file : null;
      const res = await useConversationsStore.getState().addMachine({
        label: name.trim(),
        host: target.host,
        port: target.port,
        user: user.trim(),
        identityFile,
        addresses: null,
      });
      if (!isCurrent(attempt)) {
        // The form is gone (or the attempt cancelled), but a save that landed anyway
        // still happened: what it lost goes to the app banner, which outlives the form —
        // and so does a failure the user didn't cancel.
        if (res.ok) {
          const problem = lateConnectProblem(res.machine, connectOutcome(res, identityFile), lateHow(attempt));
          if (problem) useAppErrors.getState().pushError(problem);
        } else {
          reportLateFailure(attempt, target, res.error);
        }
        return;
      }
      if (res.ok) {
        onConnected(res.machine, connectOutcome(res, identityFile));
      } else {
        setFailure({ message: res.error, hostKeyTarget: isHostKeyRejected(res.error) ? target : null });
      }
    },
    [name, user, keyMode, key, onConnected, isCurrent, lateHow, reportLateFailure],
  );

  /** Runs `work` as a new attempt against `target` — Connect stays disabled for its
   *  whole round trip, and a throw is shown like any returned error (on the app banner
   *  once the form closed under it). */
  const runAttempt = useCallback(
    async (target: SshTarget, work: (attempt: number) => Promise<void>) => {
      const attempt = ++attemptSeq.current;
      setConnecting(true);
      setFailure(null);
      try {
        await work(attempt);
      } catch (e) {
        if (isCurrent(attempt)) setFailure({ message: errorMessage(e), hostKeyTarget: null });
        else reportLateFailure(attempt, target, errorMessage(e));
      } finally {
        if (isCurrent(attempt)) setConnecting(false);
      }
    },
    [isCurrent, reportLateFailure],
  );

  const connect = useCallback(() => {
    const target = { host: address.trim(), port: Number(port) || 22 };
    return runAttempt(target, (attempt) => attemptConnect(attempt, target));
  }, [runAttempt, attemptConnect, address, port]);

  const hostKeyTarget = failure?.hostKeyTarget ?? null;
  // Step one of I6: read the key the server presents now and show it next to the saved
  // one. A key that turns out to be the saved one again just retries.
  const reviewNewKey = useCallback(() => {
    if (!hostKeyTarget) return;
    const target = hostKeyTarget;
    void runAttempt(target, async (attempt) => {
      const res = await commands.bootstrapCheckHostKey(target.host, target.port, user.trim());
      if (!isCurrent(attempt)) return; // nothing was changed — nothing owed to anyone
      if (res.status !== "ok") {
        setFailure({ message: res.error, hostKeyTarget: target });
        return;
      }
      // Already the saved key (vouched for by a paired server or not — this keyed
      // connection sends no password): nothing to replace, just retry.
      if (res.data.trust === "known" || res.data.trust === "unverified") {
        await attemptConnect(attempt, target);
        return;
      }
      setFailure({ message: "", hostKeyTarget: target });
      setReview({ target, check: res.data });
    });
  }, [hostKeyTarget, user, runAttempt, attemptConnect, isCurrent]);

  // Step two: the user confirmed the fingerprint shown — replace the saved key with
  // exactly that one, then retry.
  const trustNewKeyAndRetry = useCallback(() => {
    if (!review) return;
    const { target, check } = review;
    setReview(null);
    void runAttempt(target, async (attempt) => {
      const res = await commands.bootstrapForgetHostKey(target.host, target.port, user.trim(), check.fingerprint);
      // Cancelled: dropped. Closed without a Cancel: it carries on — the retry the user
      // asked for still runs, and reports to the app banner.
      if (!isCurrent(attempt) && lateHow(attempt) === "cancelled") return;
      if (res.status !== "ok") {
        // Verbatim: nothing was replaced, so a retry could only fail the same way.
        if (isCurrent(attempt)) setFailure({ message: res.error, hostKeyTarget: null });
        else reportLateFailure(attempt, target, res.error);
        return;
      }
      await attemptConnect(attempt, target);
    });
  }, [review, user, runAttempt, attemptConnect, isCurrent, lateHow, reportLateFailure]);

  const cancel = useCallback(() => {
    // Whatever is still in flight no longer reports to this form — nor, cancelled on
    // purpose, anywhere else (bar a save that lost Flight Deck's key).
    cancelledUpTo.current = attemptSeq.current;
    attemptSeq.current++;
    setConnecting(false);
    onClose();
  }, [onClose]);

  const copyCommand = useCallback(() => {
    if (!authorizeCommand) return;
    void navigator.clipboard.writeText(authorizeCommand).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      (e: unknown) => setKeyError(`Couldn't copy the command: ${errorMessage(e)}`),
    );
  }, [authorizeCommand]);

  return (
    <div className={sharedStyles.remotePanel}>
      <div className={sharedStyles.remoteStep}>
        <b>Connect an existing server</b> — for a server where <b>claude</b> and <b>flightdeckd</b> are already
        installed and running, like a Mac set up by hand. Flight Deck checks both over SSH, then adds it; nothing is
        installed or changed on the server.
      </div>
      <input
        className={sharedStyles.field}
        placeholder="Name (e.g. studio-mac)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Server name"
        autoComplete="off"
      />
      <input
        className={sharedStyles.field}
        placeholder="Address — an IP, hostname, or Tailscale name"
        value={address}
        onChange={(e) => {
          setAddress(e.target.value);
          dropHostKeyFailure();
        }}
        aria-label="Server address"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <div className={sharedStyles.fieldRow}>
        <input
          className={sharedStyles.field}
          style={{ flex: "0 0 96px" }}
          inputMode="numeric"
          placeholder="Port"
          value={port}
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9]/g, "");
            if (next === port) return;
            setPort(next);
            dropHostKeyFailure();
          }}
          aria-label="SSH port"
          autoComplete="off"
        />
        <input
          className={sharedStyles.field}
          placeholder="User (e.g. admin)"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          aria-label="SSH user"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
      {fieldError && <div className={sharedStyles.errorMsg}>{fieldError}</div>}

      <OptionCardRail options={KEY_MODES} selected={keyMode} onSelect={setKeyMode} ariaLabel="How to log in" />
      {keyMode === "dedicated" && (
        <>
          {keyError && <div className={sharedStyles.errorMsg}>{keyError}</div>}
          {!key && !keyError && <div className={sharedStyles.remoteStep}>Creating a key…</div>}
          {authorizeCommand && (
            <>
              <div className={sharedStyles.remoteStep}>
                Run this once on the server, as <b>{user.trim() || "that user"}</b>, to let Flight Deck&apos;s key in:
              </div>
              <pre className={sharedStyles.codeBlock}>{authorizeCommand}</pre>
              <div className={sharedStyles.btnRow}>
                <button type="button" className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={copyCommand}>
                  {copied ? "Copied" : "Copy command"}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {failure && failure.message && (
        <div className={isServerBusyError(failure.message) ? sharedStyles.hintWarn : sharedStyles.errorMsg}>
          {failure.message}
        </div>
      )}
      {review ? (
        <HostKeyReview
          check={review.check}
          purpose="connect"
          busy={connecting}
          onConfirm={trustNewKeyAndRetry}
          onCancel={() => {
            setReview(null);
            setFailure(null);
          }}
        />
      ) : (
        hostKeyTarget && (
          <div className={sharedStyles.remoteStep}>
            This server&apos;s identity has changed since this Mac last connected to it. If that&apos;s expected — a
            reinstall, a new machine at that address — compare the new key and replace the old one.
            <div className={sharedStyles.btnRow} style={{ marginTop: 6 }}>
              <button
                type="button"
                className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
                disabled={connecting}
                onClick={reviewNewKey}
              >
                Review the new key
              </button>
            </div>
          </div>
        )
      )}

      <div className={sharedStyles.btnRow}>
        <button
          type="button"
          className={`${sharedStyles.btn} ${sharedStyles.primary}`}
          disabled={!canConnect}
          onClick={() => void connect()}
        >
          {connecting ? "Checking the server…" : "Connect"}
        </button>
        <span className={sharedStyles.spacer} />
        <button type="button" className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
