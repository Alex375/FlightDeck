// "Sync with this Mac" — a server panel's alignment block (CRM 763ae7f2): the per-server
// "Keep this server aligned" toggle (ON by default), "Sync now", and what the last pass did,
// part by part. Every failure is shown in the backend's words; nothing is folded away.
import { useEffect, useState } from "react";
import { Ico } from "../../ui/kit";
import { loadAlignState, setKeepAligned, syncServerNow, useMachineAlign } from "../../store/serverAlign";
import { MACHINE } from "../../ui/platform";
import { ToggleRow } from "./SettingsKit";
import { alignHeadline, alignLines } from "./serverAlignView";
import { isServerBusyError } from "./serverBootstrapModel";
import sharedStyles from "./SettingsPanel.module.css";
import styles from "./ServerStatusPanel.module.css";

export function ServerAlignSection({ machineId }: { machineId: string }) {
  const state = useMachineAlign(machineId);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadAlignState(machineId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [machineId]);

  const running = syncing || !!state?.running;
  const headline = alignHeadline(state);
  const lines = state?.last ? alignLines(state.last) : [];
  // A pass that could not start AFTER an earlier report: said under that report, which
  // still describes the server as it was last seen.
  const lateError = state?.last && state.last_error ? state.last_error : null;

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const { error: why } = await syncServerNow(machineId);
      if (why) setError(why);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={styles.align}>
      <ToggleRow
        title={`Keep this server aligned with this ${MACHINE}`}
        hint={
          <>
            Its Claude Code version, its flightdeckd and this {MACHINE}&apos;s <code>~/.claude</code> setup — settings,
            sub-agents, skills, commands, hooks, plugins, MCP servers. Checked when the server comes back within reach
            and before a sleeping conversation restarts; a conversation at work is never interrupted.
          </>
        }
        checked={state?.keep_aligned ?? true}
        disabled={!state}
        onChange={(next) => {
          void setKeepAligned(machineId, next).then((why) => setError(why));
        }}
      />
      <div className={styles.repairs}>
        <button
          type="button"
          className={`${sharedStyles.btn} ${sharedStyles.ghost}`}
          disabled={running}
          onClick={() => void syncNow()}
          title={`Bring this server in line with this ${MACHINE} now`}
        >
          <Ico name="refresh" className={running ? "sm wf-spin-fast" : "sm"} /> Sync now
        </button>
        <span className={styles.alignHeadline} data-state={running ? "muted" : headline.tone}>
          {headline.text}
        </span>
      </div>
      {lines.length > 0 && (
        <div className={styles.alignLines}>
          {lines.map((l) => (
            <div key={l.label} className={styles.alignLine}>
              <span className={styles.factLabel}>{l.label}</span>
              <span className={styles.alignText} data-state={l.tone}>
                {l.text}
              </span>
            </div>
          ))}
        </div>
      )}
      {(error ?? lateError) && (
        <div className={isServerBusyError(error ?? lateError ?? "") ? sharedStyles.hintWarn : sharedStyles.errorMsg}>
          {error ?? lateError}
        </div>
      )}
    </div>
  );
}
