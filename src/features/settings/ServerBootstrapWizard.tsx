// B12 — the primary "add a server" path: type address/user/password once, the app
// installs everything (`bootstrap_server`), with a live step checklist and inline
// handling for every `needs_input` pause the pipeline can hit. See
// `src-tauri/src/bootstrap/orchestrator.rs`'s module doc for the wire this drives.
//
// The OLD ticket/command flow (`buildServerCommand`/`parseTicket`, still defined in
// ControlSection.tsx — its own regression tests import them from there) stays reachable
// behind a secondary link, for servers this Mac can only reach with a pre-authorized
// key (no password prompt at all).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ico } from "../../ui/kit";
import { commands, events, type AddressCandidate, type HostKeyFingerprintEvent, type StepState } from "../../ipc/client";
import { bootConversations, useConversationsStore } from "../../store/conversationsStore";
import { buildServerCommand, parseTicket } from "./ControlSection";
import { ClaudeSignInInline } from "./ClaudeSignInInline";
import { ToggleRow } from "./SettingsKit";
import {
  claudeSignInStep,
  isHostKeyMismatch,
  isSudoPasswordError,
  needsSudoPassword,
  restartPendingCount,
  restartPendingStep,
  STEP_ORDER,
  stepStateFromProgress,
  toStepRows,
  type StepRowVM,
} from "./serverBootstrapModel";
import sharedStyles from "./SettingsPanel.module.css";
import wStyles from "./ServerBootstrapWizard.module.css";

const STEP_STATUS_ICON: Record<StepRowVM["status"], string> = {
  pending: "circledot",
  running: "refresh",
  ok: "check",
  skipped: "check",
  failed: "x",
  needs_input: "alert",
};

function initialSteps(): StepState[] {
  return STEP_ORDER.map((id) => ({ id, status: "pending", detail: null }));
}

function StepChecklist({ steps }: { steps: StepState[] }) {
  return (
    <div className={wStyles.steps}>
      {toStepRows(steps).map((row) => (
        <div key={row.id} className={wStyles.step} data-status={row.status}>
          <span className={wStyles.stepIcon} data-status={row.status}>
            <Ico name={STEP_STATUS_ICON[row.status]} className={row.status === "running" ? "wf-spin-fast" : undefined} />
          </span>
          <div className={wStyles.stepBody}>
            <div className={wStyles.stepLabel}>{row.label}</div>
            {row.detail && <div className={wStyles.stepDetail}>{row.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The primary wizard: form → live checklist → inline needs_input handling → done. */
function PrimaryBootstrap({ onClose, onUseLegacy }: { onClose: () => void; onUseLegacy: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  // Opt-out (default ON), applies even to a root login — see the B12 brief.
  const [keepAwake, setKeepAwake] = useState(true);

  const [steps, setSteps] = useState<StepState[]>(initialSteps());
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [needsInput, setNeedsInput] = useState<StepState["id"] | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<HostKeyFingerprintEvent | null>(null);

  const [sudoPassword, setSudoPassword] = useState("");
  const [sudoBusy, setSudoBusy] = useState(false);

  const [restartDismissed, setRestartDismissed] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartSudoPassword, setRestartSudoPassword] = useState("");
  const [restartNeedsSudo, setRestartNeedsSudo] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const [forgetBusy, setForgetBusy] = useState(false);

  // Live progress: subscribed for this component's whole lifetime. Only one bootstrap
  // call is ever in flight from this wizard at a time, so no session filtering is
  // needed to know these events are "ours".
  useEffect(() => {
    const unProgress = events.bootstrapProgressEvent.listen((e) => setSteps(stepStateFromProgress(e.payload.steps)));
    const unFingerprint = events.hostKeyFingerprintEvent.listen((e) => setFingerprint(e.payload));
    return () => {
      void unProgress.then((f) => f());
      void unFingerprint.then((f) => f());
    };
  }, []);

  // Clears every password this component ever held — called on success, on failure,
  // on cancel, and (via the effect below) on unmount. Never routes through any store
  // or localStorage, so there is nothing else to clear.
  const clearPasswords = useCallback(() => {
    setPassword("");
    setSudoPassword("");
    setRestartSudoPassword("");
  }, []);
  // Unmount: nothing here is ever written to a store or localStorage, so React
  // discarding this component's state already erases every password — this just
  // makes that guarantee explicit and independently testable.
  useEffect(() => () => clearPasswords(), [clearPasswords]);

  const applyReport = useCallback((report: {
    session_id: string;
    steps: StepState[];
    needs_input: StepState["id"] | null;
    machine_id: string | null;
  }) => {
    setSessionId(report.session_id);
    setSteps(report.steps);
    setNeedsInput(report.needs_input);
    if (report.machine_id) {
      setMachineId(report.machine_id);
      // A server was actually persisted — refresh the store's `machines` list so
      // ServerStatusPanel (and the rest of the app) sees it immediately, even if
      // Settings gets closed the instant this resolves.
      void bootConversations();
    }
  }, []);

  const install = useCallback(async () => {
    setTopError(null);
    setBusy(true);
    setStarted(true);
    setSteps(initialSteps());
    setNeedsInput(null);
    setFingerprint(null);
    setRestartDismissed(false);
    setRestartNeedsSudo(false);
    setRestartError(null);
    const pw = password;
    setPassword(""); // cleared the instant it's handed to the IPC call
    const res = await commands.bootstrapServer(
      name.trim() || address.trim(),
      address.trim(),
      Number(port) || 22,
      user.trim(),
      pw || null,
      keepAwake,
      null,
    );
    setBusy(false);
    if (res.status === "ok") applyReport(res.data);
    else setTopError(res.error);
  }, [name, address, port, user, password, keepAwake, applyReport]);

  const resume = useCallback(async () => {
    if (!sessionId) return;
    setSudoBusy(true);
    setTopError(null);
    const pw = sudoPassword;
    setSudoPassword(""); // cleared the instant it's handed off — success or failure
    const res = await commands.bootstrapResume(sessionId, pw || null);
    setSudoBusy(false);
    if (res.status === "ok") applyReport(res.data);
    else setTopError(res.error);
  }, [sessionId, sudoPassword, applyReport]);

  const cancelPaused = useCallback(() => {
    if (sessionId) void commands.bootstrapCancel(sessionId);
    clearPasswords();
    setStarted(false);
    setSteps(initialSteps());
    setSessionId(null);
    setNeedsInput(null);
    setTopError(null);
  }, [sessionId, clearPasswords]);

  const retryAfterFailure = useCallback(() => {
    clearPasswords();
    setStarted(false);
    setSteps(initialSteps());
    setTopError(null);
  }, [clearPasswords]);

  const forgetAndRetry = useCallback(async () => {
    setForgetBusy(true);
    await commands.bootstrapForgetHostKey(address.trim(), Number(port) || 22);
    setForgetBusy(false);
    void install();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, port]);

  const restartNow = useCallback(async () => {
    if (!machineId) return;
    setRestartBusy(true);
    setRestartError(null);
    const pw = restartNeedsSudo ? restartSudoPassword : null;
    setRestartSudoPassword("");
    const res = await commands.machineRepair(machineId, "restart_daemon", pw);
    setRestartBusy(false);
    if (res.status === "ok") {
      setRestartDismissed(true);
      setRestartNeedsSudo(false);
    } else if (isSudoPasswordError(res.error)) {
      setRestartNeedsSudo(true);
    } else {
      setRestartError(res.error);
    }
  }, [machineId, restartNeedsSudo, restartSudoPassword]);

  const failedStep = steps.find((s) => s.status === "failed") ?? null;
  const installKeyMismatch = useMemo(
    () => failedStep?.id === "install_key" && isHostKeyMismatch(failedStep.detail),
    [failedStep],
  );
  const paused = needsSudoPassword({ needs_input: needsInput });
  const restartStep = restartDismissed ? null : restartPendingStep(steps);
  const claudeStep = claudeSignInStep(steps);
  const pipelineSettled = started && !busy && !sudoBusy && needsInput === null;

  if (!started) {
    return (
      <div className={sharedStyles.remotePanel}>
        <div className={sharedStyles.remoteStep}>
          Type this server&apos;s connection details once — Flight Deck installs and configures
          everything else.
        </div>
        <input
          className={sharedStyles.field}
          placeholder="Name (e.g. my-vps)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={sharedStyles.field}
          placeholder="Address — an IP, hostname, or Tailscale name"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <div className={sharedStyles.fieldRow}>
          <input
            className={sharedStyles.field}
            style={{ flex: "0 0 96px" }}
            inputMode="numeric"
            placeholder="Port"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <input
            className={sharedStyles.field}
            placeholder="User (e.g. root)"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </div>
        <input
          className={sharedStyles.field}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void install();
          }}
        />
        <ToggleRow
          title="Keep this server awake (disable sleep)"
          hint="Masks the server's sleep/suspend targets so a running conversation doesn't get dropped. Applies even when logging in as root; you can turn it off later from this server's status panel."
          checked={keepAwake}
          onChange={setKeepAwake}
        />
        {topError && <div className={sharedStyles.errorMsg}>{topError}</div>}
        <div className={sharedStyles.btnRow}>
          <button
            className={`${sharedStyles.btn} ${sharedStyles.primary}`}
            disabled={busy || !address.trim() || !user.trim()}
            onClick={() => void install()}
          >
            {busy ? "Installing…" : "Install"}
          </button>
          <span className={sharedStyles.spacer} />
          <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={onClose}>
            Cancel
          </button>
        </div>
        <button type="button" className={wStyles.legacyLink} onClick={onUseLegacy}>
          Use a command instead (servers with key-only login)
        </button>
      </div>
    );
  }

  return (
    <div className={sharedStyles.remotePanel}>
      <StepChecklist steps={steps} />

      {fingerprint && (
        <div className={wStyles.infoLine}>
          <Ico name="key" />
          Host key: <span className={sharedStyles.mono}>{fingerprint.fingerprint}</span>
          {fingerprint.known ? " (already known)" : " (newly pinned)"}
        </div>
      )}

      {installKeyMismatch && (
        <div className={wStyles.actionPanel}>
          <div>This server&apos;s host key changed since it was last seen — if that&apos;s expected (a reinstall, a new host), forget the old one and try again.</div>
          <div className={sharedStyles.btnRow}>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.primary}`}
              disabled={forgetBusy}
              onClick={() => void forgetAndRetry()}
            >
              {forgetBusy ? "Retrying…" : "Forget the old key and retry"}
            </button>
          </div>
        </div>
      )}

      {paused && (
        <div className={wStyles.actionPanel}>
          <div>This server needs a sudo password to finish setting up persistence.</div>
          <input
            className={sharedStyles.field}
            type="password"
            placeholder="Sudo password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void resume();
            }}
          />
          <div className={sharedStyles.btnRow}>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.primary}`}
              disabled={sudoBusy || !sudoPassword}
              onClick={() => void resume()}
            >
              {sudoBusy ? "Resuming…" : "Resume"}
            </button>
            <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} disabled={sudoBusy} onClick={cancelPaused}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {restartStep && (
        <div className={wStyles.actionPanel}>
          <div>
            Restart pending
            {restartPendingCount(restartStep.detail) !== null
              ? ` — ${restartPendingCount(restartStep.detail)} conversation(s) running`
              : restartStep.detail
                ? ` — ${restartStep.detail.replace(/^restart pending — /, "")}`
                : ""}
            . A newer daemon is installed but not running yet.
          </div>
          {restartNeedsSudo && (
            <input
              className={sharedStyles.field}
              type="password"
              placeholder="Sudo password"
              value={restartSudoPassword}
              onChange={(e) => setRestartSudoPassword(e.target.value)}
            />
          )}
          {restartError && <div className={sharedStyles.errorMsg}>{restartError}</div>}
          <div className={sharedStyles.btnRow}>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.primary}`}
              disabled={restartBusy || (restartNeedsSudo && !restartSudoPassword)}
              onClick={() => void restartNow()}
            >
              {restartBusy ? "Restarting…" : "Restart now"}
            </button>
            <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={() => setRestartDismissed(true)}>
              Later
            </button>
          </div>
        </div>
      )}

      {claudeStep && machineId && (
        <div className={wStyles.actionPanel}>
          <div>This server isn&apos;t signed in to Claude Code yet.</div>
          <ClaudeSignInInline machineId={machineId} onSignedIn={() => setSteps((cur) => [...cur])} />
        </div>
      )}

      {failedStep && !installKeyMismatch && (
        <div className={sharedStyles.errorMsg}>{failedStep.detail ?? "This step failed."}</div>
      )}
      {topError && <div className={sharedStyles.errorMsg}>{topError}</div>}

      <div className={sharedStyles.btnRow}>
        {failedStep && (
          <button className={`${sharedStyles.btn} ${sharedStyles.primary}`} onClick={retryAfterFailure}>
            Retry
          </button>
        )}
        {!paused && (
          <button className={`${sharedStyles.btn} ${pipelineSettled ? sharedStyles.primary : sharedStyles.ghost}`} onClick={onClose}>
            {pipelineSettled && !failedStep ? "Done" : "Close"}
          </button>
        )}
      </div>
    </div>
  );
}

type LegacyStage = "command" | "confirm" | "manual";

/** The OLD ticket/paste flow, moved here verbatim from ControlSection.tsx (its own
 *  `buildServerCommand`/`parseTicket` stay put — their regression tests import them
 *  from there). Reachable as a secondary path for a server this Mac can already reach
 *  with a pre-authorized key, so a password prompt is never needed. */
function LegacyPairing({ onClose, onUsePrimary }: { onClose: () => void; onUsePrimary: () => void }) {
  const [stage, setStage] = useState<LegacyStage>("command");
  const [genKey, setGenKey] = useState<{ identityFile: string; publicKey: string } | null>(null);
  const [ticket, setTicket] = useState("");
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [addresses, setAddresses] = useState<AddressCandidate[]>([]);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await useConversationsStore.getState().generateMachineKey("server");
      if (res.ok) setGenKey({ identityFile: res.key.identity_file, publicKey: res.key.public_key });
      else setError(res.error);
    })();
  }, []);

  const serverCommand = genKey ? buildServerCommand(genKey.publicKey) : "";

  const copyCmd = useCallback(() => {
    void navigator.clipboard.writeText(serverCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [serverCommand]);

  const continueFromTicket = useCallback(() => {
    const t = parseTicket(ticket);
    if (!t) {
      setError("Couldn't read that ticket — copy the whole fdpair:… line the command printed.");
      return;
    }
    const preferred = t.addresses.find((a) => a.kind === "tailscale") ?? t.addresses[0];
    setLabel(t.label);
    setHost(preferred?.value || t.host);
    setPort(t.port || "22");
    setUser(t.user);
    setAddresses(t.addresses);
    setError(null);
    setStage("confirm");
  }, [ticket]);

  const pair = useCallback(async () => {
    setBusy(true);
    setError(null);
    const res = await useConversationsStore.getState().addMachine({
      label: label.trim() || host.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      user: user.trim(),
      identityFile: genKey?.identityFile ?? null,
      addresses: addresses.length > 0 ? addresses : null,
    });
    setBusy(false);
    if (res.ok) {
      setGenKey(null);
      onClose();
    } else {
      setError(res.error);
    }
  }, [label, host, port, user, genKey, addresses, onClose]);

  return (
    <div className={sharedStyles.remotePanel}>
      {stage === "command" && (
        <>
          <div className={sharedStyles.remoteStep}>
            <b>1 · Run this once on your server.</b> Open a shell on it (over SSH, or on the
            machine itself) and paste. It authorizes Flight Deck, checks Claude, and prints a
            pairing ticket. Nothing to type here — Flight Deck already made a dedicated key.
          </div>
          {serverCommand ? (
            <>
              <pre className={sharedStyles.codeBlock}>{serverCommand}</pre>
              <div className={sharedStyles.btnRow}>
                <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={copyCmd}>
                  {copied ? "Copied" : "Copy command"}
                </button>
              </div>
            </>
          ) : (
            <div className={sharedStyles.remoteStep}>{error ? "" : "Preparing the command…"}</div>
          )}
          <div className={sharedStyles.remoteStep}>
            <b>2 · Paste the ticket</b> it printed (the <b>fdpair:…</b> line):
          </div>
          <input
            className={sharedStyles.field}
            placeholder="fdpair:…"
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") continueFromTicket();
            }}
          />
          {error && <div className={sharedStyles.errorMsg}>{error}</div>}
          <div className={sharedStyles.btnRow}>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.primary}`}
              disabled={!ticket.trim()}
              onClick={continueFromTicket}
            >
              Continue
            </button>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
              onClick={() => {
                setError(null);
                setAddresses([]);
                setStage("manual");
              }}
            >
              Enter details manually
            </button>
            <span className={sharedStyles.spacer} />
            <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={onClose}>
              Cancel
            </button>
          </div>
          <button type="button" className={wStyles.legacyLink} onClick={onUsePrimary}>
            Back to the guided install
          </button>
        </>
      )}

      {(stage === "confirm" || stage === "manual") && (
        <>
          <div className={sharedStyles.remoteStep}>
            {stage === "confirm" ? (
              <>
                <b>3 · Confirm the connection</b> — the server filled these in. Fix anything that
                looks off (e.g. the host/port if it&apos;s behind a NAT or a port mapping).
              </>
            ) : (
              <>
                <b>Enter the server&apos;s details.</b> A last resort — prefer the pairing command
                above when you can.
              </>
            )}
          </div>
          <input
            className={sharedStyles.field}
            placeholder="Name (e.g. my-vps)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className={sharedStyles.field}
            placeholder="Host or IP (reachable from this Mac)"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          {stage === "confirm" && addresses.length > 1 && (
            <div className={sharedStyles.remoteStep}>
              Discovered addresses — pick one:
              <div className={sharedStyles.btnRow}>
                {addresses.map((a) => (
                  <button
                    key={`${a.kind}-${a.value}`}
                    type="button"
                    className={`${sharedStyles.btn} ${host === a.value ? sharedStyles.primary : sharedStyles.ghost}`}
                    onClick={() => setHost(a.value)}
                  >
                    {a.kind === "tailscale" ? "Tailscale" : a.kind === "lan" ? "LAN" : "Hostname"}: {a.value}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className={sharedStyles.fieldRow}>
            <input
              className={sharedStyles.field}
              style={{ flex: "0 0 96px" }}
              inputMode="numeric"
              placeholder="Port"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <input
              className={sharedStyles.field}
              placeholder="User (e.g. root)"
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          </div>
          {error && <div className={sharedStyles.errorMsg}>{error}</div>}
          <div className={sharedStyles.btnRow}>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.primary}`}
              disabled={busy || !host.trim() || !user.trim()}
              onClick={() => void pair()}
            >
              {busy ? "Testing…" : "Test & pair"}
            </button>
            {stage === "confirm" && (
              <button
                className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
                onClick={() => {
                  setError(null);
                  setAddresses([]);
                  setStage("command");
                }}
              >
                Back
              </button>
            )}
            <span className={sharedStyles.spacer} />
            <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The wizard shown when "+ Add a server" is open — the primary guided install, with
 *  the legacy ticket flow one link away. `onClose` dismisses it (successful pairing or
 *  an explicit Cancel/Done alike — the caller doesn't need to know which). */
export function ServerBootstrapWizard({ onClose }: { onClose: () => void }) {
  const [useLegacy, setUseLegacy] = useState(false);
  if (useLegacy) {
    return <LegacyPairing onClose={onClose} onUsePrimary={() => setUseLegacy(false)} />;
  }
  return <PrimaryBootstrap onClose={onClose} onUseLegacy={() => setUseLegacy(true)} />;
}
