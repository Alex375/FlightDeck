// B12 — the primary "add a server" path: type address/user/password once, the app
// installs everything (`bootstrap_server`), with a live step checklist and inline
// handling for every `needs_input` pause the pipeline can hit. See
// `src-tauri/src/bootstrap/orchestrator.rs`'s module doc for the wire this drives.
//
// The OLD ticket/command flow (`buildServerCommand`/`parseTicket`, still defined in
// ControlSection.tsx — its own regression tests import them from there) stays reachable
// behind a secondary link, for servers this Mac can only reach with a pre-authorized
// key (no password prompt at all).
//
// ⚠️ `install`/`runInstall` split (review fix): the typed password is cleared from
// `password` state the instant an attempt submits — win or lose — so a HostKeyMismatch
// failure's own "Forget the old key and retry" can't just re-read `password`, and an
// earlier version of this file also memoized `forgetAndRetry` over a stale `install`
// closure on top of that, so the retry silently went out with an EMPTY user/password.
// `runInstall(pw)` is the shared body both `install()` and `forgetAndRetry()` call;
// `pendingKeyPasswordRef` is what lets the retry hand back the password that was
// actually typed. See `ServerBootstrapWizard.test.ts`'s "retries with the password
// actually typed" test.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../../ui/kit";
import { commands, events, type AddressCandidate, type HostKeyFingerprintEvent, type StepState } from "../../ipc/client";
import { bootConversations, useConversationsStore } from "../../store/conversationsStore";
import { useSettingsUi } from "../../store/settingsUi";
import { buildServerCommand, parseTicket } from "./ControlSection";
import { ClaudeSignInInline } from "./ClaudeSignInInline";
import { ToggleRow } from "./SettingsKit";
import {
  claudeSignInStep,
  isHostKeyMismatch,
  isServerBusyError,
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

/** A rejected promise's message, for the paths below that must surface a genuine
 *  transport-level exception (not just a returned `{status:"error"}`) — see the
 *  generated binding's own `catch`, which re-throws a real `Error` verbatim. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `errorMsg`'s discreet sibling for a `server_busy_error` collision (review finding:
 *  `isServerBusyError` was defined and tested but never actually called anywhere) —
 *  it isn't a failure of THIS attempt, just another operation already running against
 *  the same server, so it reads as a transient "wait and retry" notice rather than a
 *  hard red error. */
function errorBoxClass(message: string | null): string {
  return isServerBusyError(message) ? sharedStyles.hintWarn : sharedStyles.errorMsg;
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

  // Holds the password from the run that just failed as a `HostKeyMismatch`, so
  // "Forget the old key and retry" can hand it BACK to a fresh `bootstrap_server`
  // call — `password` (the visible field) is cleared the instant `install` submits
  // it, win or lose, so by the time this failure panel shows, that state is already
  // empty. Never rendered, never touched by anything but `install`/`forgetAndRetry`;
  // cleared by `clearPasswords` the same as every other password this component
  // holds (retry-after-failure, cancel, unmount).
  const pendingKeyPasswordRef = useRef<string | null>(null);

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
    pendingKeyPasswordRef.current = null;
  }, []);
  // Unmount: nothing here is ever written to a store or localStorage, so React
  // discarding this component's state already erases every password — this just
  // makes that guarantee explicit and independently testable. The ref above is
  // scrubbed explicitly since React discarding the component doesn't null it out.
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
    // Hold onto `pendingKeyPasswordRef` only for as long as ANOTHER host-key-mismatch
    // retry might still need it — once the run lands anywhere else (success, a
    // different failure, a needs_input pause), there is nothing left that would ever
    // read it again, so scrub it right away rather than waiting for the next explicit
    // retry/cancel/unmount.
    const stillMismatched = report.steps.some(
      (s) => s.id === "install_key" && s.status === "failed" && isHostKeyMismatch(s.detail),
    );
    if (!stillMismatched) pendingKeyPasswordRef.current = null;
  }, []);

  // The actual pipeline call, parameterized by password so both a fresh `install()`
  // and a same-run `forgetAndRetry()` go through the identical body — see the module
  // doc up top: a stale/empty password on that retry hop was a real shipped bug.
  const runInstall = useCallback(
    async (pw: string | null) => {
      setTopError(null);
      setBusy(true);
      setStarted(true);
      setSteps(initialSteps());
      setNeedsInput(null);
      setFingerprint(null);
      setRestartDismissed(false);
      setRestartNeedsSudo(false);
      setRestartError(null);
      try {
        const res = await commands.bootstrapServer(
          name.trim() || address.trim(),
          address.trim(),
          Number(port) || 22,
          user.trim(),
          pw,
          keepAwake,
          null,
        );
        if (res.status === "ok") applyReport(res.data);
        else {
          setTopError(res.error);
          pendingKeyPasswordRef.current = null;
        }
      } catch (e) {
        setTopError(errorMessage(e));
        pendingKeyPasswordRef.current = null;
      } finally {
        setBusy(false);
      }
    },
    [name, address, port, user, keepAwake, applyReport],
  );

  const install = useCallback(() => {
    const pw = password;
    setPassword(""); // cleared the instant it's handed to the IPC call
    pendingKeyPasswordRef.current = pw || null; // …but kept for a same-run "forget and retry" hop
    return runInstall(pw || null);
  }, [password, runInstall]);

  const resume = useCallback(async () => {
    if (!sessionId) return;
    setSudoBusy(true);
    setTopError(null);
    const pw = sudoPassword;
    setSudoPassword(""); // cleared the instant it's handed off — success or failure
    try {
      const res = await commands.bootstrapResume(sessionId, pw || null);
      if (res.status === "ok") applyReport(res.data);
      else setTopError(res.error);
    } catch (e) {
      setTopError(errorMessage(e));
    } finally {
      setSudoBusy(false);
    }
  }, [sessionId, sudoPassword, applyReport]);

  const cancelPaused = useCallback(async () => {
    const id = sessionId;
    clearPasswords();
    setStarted(false);
    setSteps(initialSteps());
    setSessionId(null);
    setNeedsInput(null);
    setTopError(null);
    if (!id) return;
    try {
      const res = await commands.bootstrapCancel(id);
      // A failed cancel leaves the paused session (and the sudo password it was
      // holding server-side) alive behind a form that now looks blank — not
      // something this view can retry (there's no session id left to target once
      // the form above has reset), but silently pretending it worked would be worse.
      // At minimum, this makes it visible rather than swallowed.
      if (res.status !== "ok") console.error(`bootstrap_cancel(${id}) failed:`, res.error);
    } catch (e) {
      console.error(`bootstrap_cancel(${id}) rejected:`, errorMessage(e));
    }
  }, [sessionId, clearPasswords]);

  const retryAfterFailure = useCallback(() => {
    clearPasswords();
    setStarted(false);
    setSteps(initialSteps());
    setTopError(null);
  }, [clearPasswords]);

  const forgetAndRetry = useCallback(async () => {
    setForgetBusy(true);
    setTopError(null);
    try {
      const res = await commands.bootstrapForgetHostKey(address.trim(), Number(port) || 22);
      if (res.status !== "ok") {
        // Forgetting the key itself is what failed — retrying `install` against the
        // still-mismatched pin would only reproduce the exact same host-key error on
        // a loop, with nothing telling the user THIS step is the one actually broken.
        setTopError(res.error);
        return;
      }
      // The password from the run that just failed — `password` (the visible field)
      // was already cleared the moment that first attempt submitted; this is the only
      // place it survived. `null` when the very first attempt never got a password at
      // all (the key might still turn out to already be installed once the new host
      // key is accepted, and `runInstall` finds out for real rather than guessing).
      await runInstall(pendingKeyPasswordRef.current);
    } catch (e) {
      setTopError(errorMessage(e));
    } finally {
      setForgetBusy(false);
    }
  }, [address, port, runInstall]);

  const restartNow = useCallback(async () => {
    if (!machineId) return;
    setRestartBusy(true);
    setRestartError(null);
    const pw = restartNeedsSudo ? restartSudoPassword : null;
    setRestartSudoPassword("");
    try {
      const res = await commands.machineRepair(machineId, "restart_daemon", pw);
      if (res.status === "ok") {
        setRestartDismissed(true);
        setRestartNeedsSudo(false);
      } else if (isSudoPasswordError(res.error)) {
        setRestartNeedsSudo(true);
      } else {
        setRestartError(res.error);
      }
    } catch (e) {
      setRestartError(errorMessage(e));
    } finally {
      setRestartBusy(false);
    }
  }, [machineId, restartNeedsSudo, restartSudoPassword]);

  const dismissRestartLater = useCallback(() => {
    setRestartDismissed(true);
    // The user opted OUT of restarting right now — a sudo password already typed for
    // it (if any) has no further use and shouldn't linger in state past this point,
    // same discipline as every other dismissal in this component.
    setRestartSudoPassword("");
    setRestartNeedsSudo(false);
  }, []);

  const failedStep = steps.find((s) => s.status === "failed") ?? null;
  const installKeyMismatch = useMemo(
    () => failedStep?.id === "install_key" && isHostKeyMismatch(failedStep.detail),
    [failedStep],
  );
  const paused = needsSudoPassword({ needs_input: needsInput });
  const restartStep = restartDismissed ? null : restartPendingStep(steps);
  const claudeStep = claudeSignInStep(steps);
  const pipelineSettled = started && !busy && !sudoBusy && needsInput === null;

  // Mirrors `paused`/`sessionId` for the unmount cleanup below, whose closure (an
  // empty-deps `useEffect`'s returned cleanup) only ever sees the FIRST render's
  // values otherwise — this ref is what lets that cleanup act on the LATEST pause
  // state instead of "never paused, no session yet".
  const pausedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    pausedSessionIdRef.current = paused ? sessionId : null;
  }, [paused, sessionId]);

  // Guards `SettingsPanel`'s close paths (✕, Escape, the scrim) against silently
  // discarding this exact pause — see the store field's own doc. `paused` is the
  // ONLY case a fresh Settings reopen can't recover from (no session-listing IPC to
  // find it again by), which is why this tracks it and nothing else needs-input-y.
  useEffect(() => {
    useSettingsUi.getState().setBootstrapGuard(
      paused ? "This server needs a sudo password to finish setting up persistence." : null,
    );
  }, [paused]);
  // Unconditional on unmount, regardless of `paused`'s last value — leaving this view
  // (Settings actually closing, or the parent tearing the wizard down after a Cancel/
  // Done) always means there is nothing left here for the guard to protect.
  //
  // Also releases the paused run's own backend `ServerLocks` claim (review finding):
  // `SettingsPanel`'s ✕/Escape/scrim close path (its "Close anyway" confirm dialog)
  // unmounts this component WITHOUT ever going through `cancelPaused`'s own explicit
  // `bootstrapCancel` call — before this fix that left the per-server lock
  // (`orchestrator.rs`'s `ServerLocks`) claimed for the rest of the app's life, since
  // only `bootstrap_resume`'s own completion or `bootstrap_cancel` ever releases a
  // paused run's claim. Every later `bootstrap_server`/`bootstrap_resume`/
  // `machine_repair` against that same host then got `server_busy_error` forever, even
  // though nothing was actually running. `cancelPaused` (this wizard's own Cancel
  // button) already resets `sessionId`/`needsInput` synchronously before its own
  // `bootstrapCancel` call, so by the time THIS cleanup runs afterward,
  // `pausedSessionIdRef.current` is already `null` — no double-cancel.
  useEffect(
    () => () => {
      useSettingsUi.getState().setBootstrapGuard(null);
      const id = pausedSessionIdRef.current;
      if (id) {
        void commands.bootstrapCancel(id).catch((e) => {
          console.error(`bootstrapCancel(${id}) on unmount failed:`, errorMessage(e));
        });
      }
    },
    [],
  );

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
            placeholder="User (e.g. root)"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            aria-label="SSH user"
            autoComplete="off"
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
          aria-label="SSH password"
          autoComplete="new-password"
        />
        <ToggleRow
          title="Keep this server awake (disable sleep)"
          hint="Masks the server's sleep/suspend targets so a running conversation doesn't get dropped. Applies even when logging in as root; you can turn it off later from this server's status panel."
          checked={keepAwake}
          onChange={setKeepAwake}
        />
        {topError && <div className={errorBoxClass(topError)}>{topError}</div>}
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
            aria-label="Sudo password"
            autoComplete="new-password"
          />
          <div className={sharedStyles.btnRow}>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.primary}`}
              disabled={sudoBusy || !sudoPassword}
              onClick={() => void resume()}
            >
              {sudoBusy ? "Resuming…" : "Resume"}
            </button>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
              disabled={sudoBusy}
              onClick={() => void cancelPaused()}
            >
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
          {!machineId ? (
            <div className={sharedStyles.note}>
              Waiting for the rest of the install to finish before this server can be restarted.
            </div>
          ) : (
            <>
              {restartNeedsSudo && (
                <input
                  className={sharedStyles.field}
                  type="password"
                  placeholder="Sudo password"
                  value={restartSudoPassword}
                  onChange={(e) => setRestartSudoPassword(e.target.value)}
                  aria-label="Sudo password for the restart"
                  autoComplete="new-password"
                />
              )}
              {restartError && <div className={sharedStyles.errorMsg}>{restartError}</div>}
            </>
          )}
          <div className={sharedStyles.btnRow}>
            <button
              className={`${sharedStyles.btn} ${sharedStyles.primary}`}
              disabled={!machineId || restartBusy || (restartNeedsSudo && !restartSudoPassword)}
              onClick={() => void restartNow()}
            >
              {restartBusy ? "Restarting…" : "Restart now"}
            </button>
            <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={dismissRestartLater}>
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
      {topError && <div className={errorBoxClass(topError)}>{topError}</div>}

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

type LegacyStage = "command" | "confirm" | "manual" | "done";

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
  // Set only when a pairing converged on an ALREADY-paired server (see `addMachine`'s
  // `matchedExisting`) — the label to say "Updated the existing server ..." about,
  // instead of the panel just closing as if a second server had silently appeared.
  const [updatedExistingLabel, setUpdatedExistingLabel] = useState<string | null>(null);

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
      if (res.matchedExisting) {
        // This host (or one of its other recorded addresses) was already paired —
        // the row was UPDATED, not added. Say so rather than closing silently, which
        // would read as a second server having appeared.
        setUpdatedExistingLabel(res.machine.label);
        setStage("done");
      } else {
        onClose();
      }
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
            aria-label="Pairing ticket"
            autoComplete="off"
          />
          {error && <div className={errorBoxClass(error)}>{error}</div>}
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
            aria-label="Server name"
            autoComplete="off"
          />
          <input
            className={sharedStyles.field}
            placeholder="Host or IP (reachable from this Mac)"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            aria-label="Server host or IP"
            autoComplete="off"
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
              aria-label="SSH port"
              autoComplete="off"
            />
            <input
              className={sharedStyles.field}
              placeholder="User (e.g. root)"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              aria-label="SSH user"
              autoComplete="off"
            />
          </div>
          {error && <div className={errorBoxClass(error)}>{error}</div>}
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

      {stage === "done" && (
        <>
          <div className={sharedStyles.remoteStep}>
            Updated the existing server &ldquo;{updatedExistingLabel}&rdquo; — this host was already
            paired, so nothing new was added.
          </div>
          <div className={sharedStyles.btnRow}>
            <button className={`${sharedStyles.btn} ${sharedStyles.primary}`} onClick={onClose}>
              Done
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
