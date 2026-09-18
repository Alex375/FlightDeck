// B12 — the per-server card in "Remote servers (SSH)": a live `machine_diagnose`
// headline + its independent tri-state facts, a Refresh button, and one repair button
// per actionable diagnosis (`machine_repair`). Replaces the old plain `.remoteRow` —
// everything that row already did (phone-provisioning status, New conversation…,
// Remove) is folded in here so there is one card per server, not two.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Ico } from "../../ui/kit";
import { commands, type RepairAction, type ServerDiagnosis } from "../../ipc/client";
import type { Machine } from "../../store/conversationsStore";
import { ClaudeSignInInline } from "./ClaudeSignInInline";
import type { ProvisionStatusLabel } from "./provisionStatus";
import {
  claudeNeedsSignIn,
  headlineLabel,
  headlineTone,
  isSudoPasswordError,
  repairSuggestionsFor,
  tri,
} from "./serverBootstrapModel";
import sharedStyles from "./SettingsPanel.module.css";
import styles from "./ServerStatusPanel.module.css";

/** One tri-state or free-text fact row. `value` pre-formatted by the caller (below) so
 *  this stays a dumb renderer. */
function FactRow({ label, value, toneTri }: { label: string; value: string; toneTri?: "yes" | "no" | "unknown" }) {
  return (
    <div className={styles.factRow}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue} data-tri={toneTri}>
        {value}
      </span>
    </div>
  );
}

/** Pure(ish) presentational core — headline + fact rows + repair buttons for a GIVEN
 *  diagnosis. Exported so the "right headline + repair action per canned diagnosis"
 *  behaviour is directly testable without mocking IPC. */
export function DiagnosisSummary({
  diagnosis,
  repairBusy,
  onRepair,
}: {
  diagnosis: ServerDiagnosis;
  repairBusy: RepairAction | null;
  onRepair: (action: RepairAction) => void;
}) {
  const tone = headlineTone(diagnosis.state);
  const suggestions = repairSuggestionsFor(diagnosis);
  const versionValue =
    diagnosis.restart_pending && diagnosis.daemon_version_disk
      ? `${diagnosis.daemon_version_running ?? "?"} running (v${diagnosis.daemon_version_disk} on disk — restart pending)`
      : (diagnosis.daemon_version_running ?? diagnosis.daemon_version_disk ?? "unknown");

  return (
    <>
      <span className={styles.headline} data-tone={tone}>
        <span className={styles.headlineDot} />
        {headlineLabel(diagnosis.state)}
      </span>
      <div className={styles.rows}>
        <FactRow label="Daemon running" value={triLabel(diagnosis.daemon_running)} toneTri={tri(diagnosis.daemon_running)} />
        <FactRow label="Version" value={versionValue} toneTri={diagnosis.restart_pending ? "no" : undefined} />
        <FactRow label="Survives reboot" value={triLabel(diagnosis.reboot_safe)} toneTri={tri(diagnosis.reboot_safe)} />
        <FactRow label="Sleep disabled" value={triLabel(diagnosis.sleep_masked)} toneTri={tri(diagnosis.sleep_masked)} />
        <FactRow label="Claude installed" value={triLabel(diagnosis.claude_installed)} toneTri={tri(diagnosis.claude_installed)} />
        <FactRow
          label="Claude signed in"
          value={diagnosis.claude_logged_in && diagnosis.claude_email ? diagnosis.claude_email : triLabel(diagnosis.claude_logged_in)}
          toneTri={tri(diagnosis.claude_logged_in)}
        />
        <FactRow label="Tailscale" value={diagnosis.tailscale_name ?? "unknown"} />
        <FactRow label="Last boot" value={diagnosis.last_boot ?? "unknown"} />
        <FactRow
          label="Busy conversations"
          value={diagnosis.busy_conversations === null ? "unknown" : String(diagnosis.busy_conversations)}
        />
      </div>
      {suggestions.length > 0 && (
        <div className={styles.repairs}>
          {suggestions.map((s) => (
            <button
              key={s.action}
              type="button"
              className={styles.repairBtn}
              disabled={repairBusy !== null}
              onClick={() => onRepair(s.action)}
            >
              <span className={styles.repairTitle}>{repairBusy === s.action ? "Working…" : s.title}</span>
              <span className={styles.repairReason}>{s.reason}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function triLabel(v: boolean | null | undefined): string {
  return v === true ? "Yes" : v === false ? "No" : "Unknown";
}

export function ServerStatusPanel({
  machine,
  provisionLabel,
  revokeLabel,
  isRetrying,
  onRetryProvisioning,
  onNewConversation,
  onRemove,
  children,
}: {
  machine: Machine;
  provisionLabel: ProvisionStatusLabel;
  revokeLabel: ProvisionStatusLabel | null;
  isRetrying: boolean;
  onRetryProvisioning: () => void;
  onNewConversation: () => void;
  onRemove: () => void;
  /** The inline "New conversation…" folder picker, rendered by the parent when open —
   *  kept out of this component (unrelated to B12, pre-existing feature). */
  children?: ReactNode;
}) {
  const [diagnosis, setDiagnosis] = useState<ServerDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [repairBusy, setRepairBusy] = useState<RepairAction | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairSudoAction, setRepairSudoAction] = useState<RepairAction | null>(null);
  const [repairSudoPassword, setRepairSudoPassword] = useState("");
  const [showClaudeSignIn, setShowClaudeSignIn] = useState(false);

  // Always diagnoses FRESH on mount — never a cached/last-known stage. This is what
  // makes "close Settings mid-install, reopen" safe without any extra plumbing: the
  // wizard's own live progress lives only in ITS component state, gone the instant it
  // unmounts, so a reopened Settings always shows reality off this call instead of a
  // stale local snapshot.
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void commands.machineDiagnose(machine.id).then((res) => {
      if (disposed) return;
      setLoading(false);
      if (res.status === "ok") setDiagnosis(res.data);
    });
    return () => {
      disposed = true;
    };
  }, [machine.id]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const res = await commands.machineDiagnose(machine.id);
    setRefreshing(false);
    if (res.status === "ok") setDiagnosis(res.data);
  }, [machine.id]);

  const runRepair = useCallback(
    async (action: RepairAction, password: string | null) => {
      setRepairBusy(action);
      setRepairError(null);
      const res = await commands.machineRepair(machine.id, action, password);
      setRepairBusy(null);
      if (res.status === "ok") {
        setDiagnosis(res.data.diagnosis);
        setRepairSudoAction(null);
        setRepairSudoPassword("");
      } else if (isSudoPasswordError(res.error)) {
        setRepairSudoAction(action);
      } else {
        setRepairError(res.error);
      }
    },
    [machine.id],
  );

  const onRepair = useCallback(
    (action: RepairAction) => {
      setRepairSudoAction(null);
      void runRepair(action, null);
    },
    [runRepair],
  );

  const submitRepairSudo = useCallback(() => {
    if (!repairSudoAction) return;
    const pw = repairSudoPassword;
    setRepairSudoPassword(""); // cleared the instant it's handed off
    void runRepair(repairSudoAction, pw || null);
  }, [repairSudoAction, repairSudoPassword, runRepair]);

  // Never written to any store/localStorage, so unmount already erases it — explicit
  // for the same reason as the wizard's own equivalent.
  useEffect(() => () => setRepairSudoPassword(""), []);

  return (
    <div>
      <div className={sharedStyles.remoteRow}>
        <div className={sharedStyles.remoteMain}>
          <span className={sharedStyles.remoteName}>{machine.label}</span>
          <span className={sharedStyles.mono}>
            {machine.user}@{machine.host}:{machine.port}
          </span>
          {machine.daemonLabel ? <span className={sharedStyles.remoteStatusText}>daemon: {machine.daemonLabel}</span> : null}
          {!loading && diagnosis && (
            <span className={styles.headline} data-tone={headlineTone(diagnosis.state)}>
              <span className={styles.headlineDot} />
              {headlineLabel(diagnosis.state)}
            </span>
          )}
          <span className={provisionLabel.isProblem ? sharedStyles.dangerText : sharedStyles.remoteStatusText}>
            phone access: {isRetrying ? "pending…" : provisionLabel.text}
          </span>
          {revokeLabel ? (
            <span className={revokeLabel.isProblem ? sharedStyles.dangerText : sharedStyles.remoteStatusText}>
              {revokeLabel.text}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
          disabled={refreshing || loading}
          onClick={() => void refresh()}
          title="Refresh this server's status"
        >
          <Ico name="refresh" className={refreshing ? "sm wf-spin-fast" : "sm"} />
        </button>
        {provisionLabel.canRetry && !isRetrying && (
          <button
            className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
            onClick={onRetryProvisioning}
            title="Retry granting this server phone access"
          >
            Retry
          </button>
        )}
        <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={onNewConversation}>
          New conversation…
        </button>
        <button className={`${sharedStyles.btn} ${sharedStyles.ghost}`} onClick={onRemove}>
          Remove
        </button>
      </div>

      {loading ? (
        <div className={styles.checking}>Checking…</div>
      ) : diagnosis ? (
        <>
          <DiagnosisSummary diagnosis={diagnosis} repairBusy={repairBusy} onRepair={onRepair} />
          {repairSudoAction && (
            <div className={styles.repairs}>
              <input
                className={sharedStyles.field}
                style={{ flex: "0 0 220px" }}
                type="password"
                placeholder="Sudo password"
                value={repairSudoPassword}
                onChange={(e) => setRepairSudoPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRepairSudo();
                }}
              />
              <button
                type="button"
                className={`${sharedStyles.btn} ${sharedStyles.primary}`}
                disabled={!repairSudoPassword || repairBusy !== null}
                onClick={submitRepairSudo}
              >
                Retry with sudo password
              </button>
            </div>
          )}
          {repairError && <div className={sharedStyles.errorMsg}>{repairError}</div>}
          {/* `sign_in_claude` never appears in `repairSuggestionsFor` — see its own doc
              — so it gets its own always-available action here instead. */}
          {claudeNeedsSignIn(diagnosis) && !showClaudeSignIn && (
            <div className={styles.repairs}>
              <button type="button" className={styles.repairBtn} onClick={() => setShowClaudeSignIn(true)}>
                <span className={styles.repairTitle}>Sign in to Claude</span>
                <span className={styles.repairReason}>
                  {diagnosis.claude_installed === false ? "Claude Code isn't installed" : "Claude Code isn't signed in"}
                </span>
              </button>
            </div>
          )}
          {showClaudeSignIn && (
            <div className={styles.repairs} style={{ display: "block" }}>
              <ClaudeSignInInline
                machineId={machine.id}
                onSignedIn={() => {
                  setShowClaudeSignIn(false);
                  void refresh();
                }}
              />
            </div>
          )}
        </>
      ) : null}

      {children}
    </div>
  );
}
