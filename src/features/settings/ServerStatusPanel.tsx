// B12 — the per-server card in "Remote servers (SSH)": a live `machine_diagnose`
// headline + its independent tri-state facts, a Refresh button, and one repair button
// per actionable diagnosis (`machine_repair`). Replaces the old plain `.remoteRow` —
// everything that row already did (phone-provisioning status, New conversation…,
// Remove) is folded in here so there is one card per server, not two.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Ico } from "../../ui/kit";
import { commands, type RepairAction, type ServerDiagnosis } from "../../ipc/client";
import type { Machine } from "../../store/conversationsStore";
import { useMachineActiveConversationIds } from "../../agent/fleet";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ClaudeSignInInline } from "./ClaudeSignInInline";
import { useClaudeLoginSessions } from "./claudeLoginSessions";
import { useMachineHealthStore } from "../../store/machineHealth";
import type { ProvisionStatusLabel } from "./provisionStatus";
import {
  claudeNeedsSignIn,
  headlineLabel,
  headlineTone,
  isNeedsConnectionPasswordError,
  isServerBusyError,
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
  showHeadline = true,
}: {
  diagnosis: ServerDiagnosis;
  repairBusy: RepairAction | null;
  onRepair: (action: RepairAction) => void;
  /** False when the caller already shows the headline chip (the server card shows it
   *  next to the server's name — two identical chips stacked was confusing). */
  showHeadline?: boolean;
}) {
  const tone = headlineTone(diagnosis.state);
  const suggestions = repairSuggestionsFor(diagnosis);
  const versionValue =
    diagnosis.restart_pending && diagnosis.daemon_version_disk
      ? `${diagnosis.daemon_version_running ?? "?"} running (v${diagnosis.daemon_version_disk} on disk — restart pending)`
      : (diagnosis.daemon_version_running ?? diagnosis.daemon_version_disk ?? "unknown");

  return (
    <>
      {showHeadline && (
        <span className={styles.headline} data-tone={tone}>
          <span className={styles.headlineDot} />
          {headlineLabel(diagnosis.state)}
        </span>
      )}
      {diagnosis.reachable ? (
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
      ) : (
        // (CRM `c9bf1482`) An unreachable server has NOTHING confirmed to show in
        // the fact-row grid above (every field is `null`, not `false` — see
        // `ServerDiagnosis::unreachable_with`'s own doc) — rendering it here would
        // be nine rows of "Unknown". Instead: an informational note ONLY for a
        // changed host identity (no repair button — see `repairSuggestionsFor`'s
        // own doc for why), and a Tailscale fact row ONLY on positive local
        // evidence that it is off.
        <>
          {diagnosis.link_issue === "host_key_changed" && (
            <p className={styles.hostKeyNote}>
              This server&apos;s identity has changed since this Mac last connected to it. If
              that&apos;s expected — a reinstall, a new host — remove this server and add it
              again.
            </p>
          )}
          {diagnosis.tailscale_off_locally === true && (
            <div className={styles.rows}>
              <FactRow label="Tailscale (this Mac)" value="Off" toneTri="no" />
            </div>
          )}
        </>
      )}
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
  recheckToken = 0,
  children,
}: {
  machine: Machine;
  provisionLabel: ProvisionStatusLabel;
  revokeLabel: ProvisionStatusLabel | null;
  isRetrying: boolean;
  onRetryProvisioning: () => void;
  onNewConversation: () => void;
  onRemove: () => void;
  /** Bumped by the parent whenever something IT owns finished a round trip to this
   *  server — today only "Retry" (phone access), which lives in the parent's state. A
   *  change re-runs this card's own `refresh`, so the headline stops contradicting what
   *  just visibly worked AND the machine-health store (hence the sidebar mark and the
   *  composer band) learns the server answered. Everything this card owns already
   *  refreshes itself (Refresh, a repair, a server sign-in). */
  recheckToken?: number;
  /** The inline "New conversation…" folder picker, rendered by the parent when open —
   *  kept out of this component (unrelated to B12, pre-existing feature). */
  children?: ReactNode;
}) {
  const [diagnosis, setDiagnosis] = useState<ServerDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Orders the three producers of a diagnosis for THIS card — the mount effect, Refresh
  // (which "Retry" drives through `recheckToken`) and a repair. They overlap routinely:
  // the mount probe is bounded at 20s against a dead server, and Retry is clickable
  // while it is still in flight. Whoever answered LAST used to win, so a slow
  // "unreachable" landed on top of the fresh "ready" the user had just asked for. Each
  // producer takes a ticket before its round trip and only writes if it still holds the
  // latest one. Its `startedAtMs` twin does the same job inside the health store, for
  // the surfaces outside this card.
  const diagGen = useRef(0);
  // Set on a FAILED `machine_diagnose` (initial load or Refresh) — never silently
  // dropped: with no `diagnosis` yet this is the only thing standing between the
  // card and a blank space below the server's name/address row, and even once a
  // `diagnosis` exists (a failed Refresh after an earlier success), it still says so
  // rather than quietly keeping the stale one on screen with nothing to show for it.
  const [diagError, setDiagError] = useState<string | null>(null);
  const [repairBusy, setRepairBusy] = useState<RepairAction | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairSudoAction, setRepairSudoAction] = useState<RepairAction | null>(null);
  const [repairSudoPassword, setRepairSudoPassword] = useState("");
  const [showClaudeSignIn, setShowClaudeSignIn] = useState(false);
  // Remove-server confirm: only asked when this server has live work on it (same
  // "busy for delete" rule the conversation/repo delete surfaces already gate on) —
  // removing it stops every one of these `claude` processes.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const activeConversationIds = useMachineActiveConversationIds(machine.id);
  // If every conversation on this server settles while the confirm is open, the
  // question is stale — close it, same as the sidebar/Flight Deck delete confirms do.
  useEffect(() => {
    if (confirmingRemove && activeConversationIds.length === 0) setConfirmingRemove(false);
  }, [confirmingRemove, activeConversationIds.length]);
  // B-finding #4: true while ANY surface (typically the bootstrap wizard's own inline
  // step, for a machine that was just paired) already has a sign-in in flight for this
  // machine — this card offers "Sign-in in progress…" instead of its OWN "Sign in to
  // Claude" button in that case, so a freshly-bootstrapped machine never shows two
  // independent entry points for the same thing at once.
  const claudeLoginActive = useClaudeLoginSessions((s) => s.active[machine.id] ?? false);

  // Always diagnoses FRESH on mount — never a cached/last-known stage. This is what
  // makes "close Settings mid-install, reopen" safe without any extra plumbing: the
  // wizard's own live progress lives only in ITS component state, gone the instant it
  // unmounts, so a reopened Settings always shows reality off this call instead of a
  // stale local snapshot.
  useEffect(() => {
    let disposed = false;
    const mine = ++diagGen.current;
    const startedAtMs = Date.now();
    setLoading(true);
    setDiagError(null);
    void commands.machineDiagnose(machine.id).then(
      (res) => {
        // Every diagnosis this panel pays for is also the freshest answer the remote
        // MARK could have — file it, so opening Settings clears a stale "unreachable"
        // badge (and sets one) without a second round trip. See `store/machineHealth`.
        //
        // Filed BEFORE the `disposed` gate on purpose: a verdict is a fact about the
        // machine, not about this card, and closing Settings while the round trip is in
        // flight used to throw away an answer the whole app was waiting for. The store
        // applies its own staleness rule, so this cannot overwrite a fresher one.
        if (res.status === "ok") useMachineHealthStore.getState().record(machine.id, res.data, startedAtMs);
        if (disposed) return;
        // `loading` belongs to THIS request, so it clears even when a newer probe has
        // since taken over the content — otherwise the card would read "Checking…" for
        // ever behind an answer that already landed.
        setLoading(false);
        if (mine !== diagGen.current) return;
        if (res.status === "ok") setDiagnosis(res.data);
        else setDiagError(res.error);
      },
      (e: unknown) => {
        if (disposed) return;
        setLoading(false);
        if (mine !== diagGen.current) return;
        setDiagError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [machine.id]);

  const refresh = useCallback(async () => {
    const mine = ++diagGen.current;
    const startedAtMs = Date.now();
    setRefreshing(true);
    try {
      const res = await commands.machineDiagnose(machine.id);
      if (res.status === "ok") useMachineHealthStore.getState().record(machine.id, res.data, startedAtMs);
      if (mine !== diagGen.current) return;
      if (res.status === "ok") {
        setDiagnosis(res.data);
        setDiagError(null);
      } else {
        setDiagError(res.error);
      }
    } catch (e) {
      if (mine !== diagGen.current) return;
      setDiagError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [machine.id]);

  // Re-check when the parent says one of ITS actions finished a round trip to this server
  // (see `recheckToken`). Goes through `refresh`, not the mount effect: this is a
  // re-check of a card already on screen, so it must not blank the facts back to
  // "Checking…" — the user is looking straight at them.
  const seenRecheck = useRef(recheckToken);
  useEffect(() => {
    if (recheckToken === seenRecheck.current) return;
    seenRecheck.current = recheckToken;
    void refresh();
  }, [recheckToken, refresh]);

  const runRepair = useCallback(
    async (action: RepairAction, password: string | null) => {
      const mine = ++diagGen.current;
      const startedAtMs = Date.now();
      setRepairBusy(action);
      setRepairError(null);
      const res = await commands.machineRepair(machine.id, action, password);
      setRepairBusy(null);
      if (mine !== diagGen.current) return;
      if (res.status === "ok") {
        setDiagnosis(res.data.diagnosis);
        // A repair carries its own FRESH diagnosis — the badge must follow it, or a
        // machine the user just fixed would stay red until the next poll.
        useMachineHealthStore.getState().record(machine.id, res.data.diagnosis, startedAtMs);
        setRepairSudoAction(null);
        setRepairSudoPassword("");
      } else if (isSudoPasswordError(res.error) || isNeedsConnectionPasswordError(res.error)) {
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

  // The one dismissal this prompt had NONE of before: opting out (rather than
  // submitting, or the whole panel unmounting) still has to scrub whatever was typed,
  // same as every other password dismissal in this component/the wizard.
  const cancelRepairSudo = useCallback(() => {
    setRepairSudoAction(null);
    setRepairSudoPassword("");
  }, []);

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
        <button
          className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
          onClick={() => {
            if (activeConversationIds.length > 0) setConfirmingRemove(true);
            else onRemove();
          }}
        >
          Remove
        </button>
      </div>

      {confirmingRemove && (
        <ConfirmDialog
          open
          danger
          title={`Remove "${machine.label}"?`}
          confirmLabel="Remove anyway"
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() => {
            setConfirmingRemove(false);
            onRemove();
          }}
        >
          {activeConversationIds.length === 1
            ? "1 conversation on this server is actively running — removing it stops that session."
            : `${activeConversationIds.length} conversations on this server are actively running — removing it stops all of them.`}
        </ConfirmDialog>
      )}

      {loading ? (
        <div className={styles.checking}>Checking…</div>
      ) : diagnosis ? (
        <>
          <DiagnosisSummary diagnosis={diagnosis} repairBusy={repairBusy} onRepair={onRepair} showHeadline={false} />
          {diagError && (
            <div className={sharedStyles.errorMsg}>Couldn&apos;t refresh this server&apos;s status: {diagError}</div>
          )}
          {repairSudoAction && (
            <div className={styles.repairs}>
              <input
                className={sharedStyles.field}
                style={{ flex: "0 0 220px" }}
                type="password"
                placeholder={repairSudoAction === "reconnect_mac" ? "Server login password" : "Sudo password"}
                value={repairSudoPassword}
                onChange={(e) => setRepairSudoPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRepairSudo();
                }}
                aria-label={
                  repairSudoAction === "reconnect_mac"
                    ? "Login password for reconnecting this Mac"
                    : "Sudo password for the repair"
                }
                autoComplete="new-password"
              />
              <button
                type="button"
                className={`${sharedStyles.btn} ${sharedStyles.primary}`}
                disabled={!repairSudoPassword || repairBusy !== null}
                onClick={submitRepairSudo}
              >
                {repairSudoAction === "reconnect_mac" ? "Reconnect" : "Retry with sudo password"}
              </button>
              <button
                type="button"
                className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
                disabled={repairBusy !== null}
                onClick={cancelRepairSudo}
              >
                Cancel
              </button>
            </div>
          )}
          {repairError && (
            <div className={isServerBusyError(repairError) ? sharedStyles.hintWarn : sharedStyles.errorMsg}>
              {repairError}
            </div>
          )}
          {/* `sign_in_claude` never appears in `repairSuggestionsFor` — see its own doc
              — so it gets its own always-available action here instead. */}
          {claudeNeedsSignIn(diagnosis) && !showClaudeSignIn && claudeLoginActive && (
            // Another surface (typically the bootstrap wizard, for a machine just
            // paired) already has a sign-in in flight — no second Start button (see
            // `claudeLoginActive`'s own doc above).
            <div className={styles.repairs}>
              <span className={sharedStyles.remoteStatusText}>Sign-in in progress…</span>
            </div>
          )}
          {claudeNeedsSignIn(diagnosis) && !showClaudeSignIn && !claudeLoginActive && (
            <div className={styles.repairs}>
              <button type="button" className={styles.repairBtn} onClick={() => setShowClaudeSignIn(true)}>
                <span className={styles.repairTitle}>Sign in to Claude</span>
                {/* Reachable only once `claudeNeedsSignIn` confirms claude IS
                    installed (B14) — a missing claude offers "Install Claude Code"
                    instead, via the generic `repairSuggestionsFor` button above. */}
                <span className={styles.repairReason}>Claude Code isn&apos;t signed in</span>
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
      ) : (
        <div className={styles.repairs}>
          <div className={sharedStyles.errorMsg}>
            Couldn&apos;t check this server&apos;s status{diagError ? `: ${diagError}` : "."}
          </div>
          <button
            type="button"
            className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {children}
    </div>
  );
}
