// "Connect an existing server" — the way in for a server Flight Deck's installer can't
// set up (a Mac, whose daemon is a hand-made LaunchAgent; or any box prepared by hand):
// type its SSH coordinates, `add_machine` checks over SSH that `claude` and a recent
// enough `flightdeckd` are there, and saves it. Nothing is installed or changed on the
// server. The installer wizard (`ServerBootstrapWizard`) stays the path for a fresh
// Linux box.
//
// Two ways to authenticate: this Mac's own SSH setup (`identity_file: null` — ~/.ssh
// keys, ~/.ssh/config, ssh-agent, exactly what `ssh user@host` would use), or a key
// Flight Deck mints and holds (the shared pending key, claimed on success), authorized
// on the server with a one-line command. Every failure from the probe is shown as the
// backend words it — never swallowed.
import { useCallback, useEffect, useMemo, useState } from "react";
import { commands, type GeneratedKey } from "../../ipc/client";
import { useConversationsStore, type Machine } from "../../store/conversationsStore";
import { buildAuthorizeKeyCommand } from "./ControlSection";
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ConnectExistingServerForm({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  /** The server was saved — `matchedExisting` when it updated one already listed. */
  onConnected: (machine: Machine, matchedExisting: boolean) => void;
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
  const [error, setError] = useState<string | null>(null);

  // The dedicated key is minted (or the pending one reused) the first time it's
  // chosen — never for someone who sticks with this Mac's keys.
  useEffect(() => {
    if (keyMode !== "dedicated" || key) return;
    let disposed = false;
    setKeyError(null);
    void useConversationsStore
      .getState()
      .generateMachineKey(name.trim() || address.trim() || "server")
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

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await useConversationsStore.getState().addMachine({
        label: name.trim() || address.trim(),
        host: address.trim(),
        port: Number(port) || 22,
        user: user.trim(),
        identityFile: keyMode === "dedicated" && key ? key.identity_file : null,
        addresses: null,
      });
      if (res.ok) onConnected(res.machine, res.matchedExisting);
      else setError(res.error);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  }, [name, address, port, user, keyMode, key, onConnected]);

  const forgetAndRetry = useCallback(async () => {
    setError(null);
    try {
      const res = await commands.bootstrapForgetHostKey(address.trim(), Number(port) || 22);
      if (res.status !== "ok") {
        setError(res.error);
        return;
      }
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    await connect();
  }, [address, port, connect]);

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
        onChange={(e) => setAddress(e.target.value)}
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
          onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
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

      {error && (
        <div className={isServerBusyError(error) ? sharedStyles.hintWarn : sharedStyles.errorMsg}>{error}</div>
      )}
      {error && isHostKeyRejected(error) && (
        <div className={sharedStyles.remoteStep}>
          This server&apos;s identity has changed since this Mac last connected to it. If that&apos;s expected — a
          reinstall, a new machine at that address — forget the old key and try again.
          <div className={sharedStyles.btnRow} style={{ marginTop: 6 }}>
            <button
              type="button"
              className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
              disabled={connecting}
              onClick={() => void forgetAndRetry()}
            >
              Forget the old key and retry
            </button>
          </div>
        </div>
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
        <button type="button" className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
