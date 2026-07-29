// "Claude Code CLI" card of the Updates tab: the piloted `claude` binary's version, a
// check/update button and its background auto-updater toggle. Twin of UpdateSection above it
// (which updates Flight Deck itself) — same card + VersionStatus shape, so the tab reads as
// two updaters of one system rather than two unrelated blocks.
import { useEffect } from "react";
import { useClaudeCliUpdate } from "../../store/claudeCliUpdate";
import { SettingsGroup, ToggleRow, VersionStatus } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function ClaudeCliSection() {
  const status = useClaudeCliUpdate((s) => s.status);
  const loading = useClaudeCliUpdate((s) => s.loading);
  const updating = useClaudeCliUpdate((s) => s.updating);
  const updateMessage = useClaudeCliUpdate((s) => s.updateMessage);
  const error = useClaudeCliUpdate((s) => s.error);
  const refresh = useClaudeCliUpdate((s) => s.refresh);
  const runUpdate = useClaudeCliUpdate((s) => s.runUpdate);
  const setAutoUpdate = useClaudeCliUpdate((s) => s.setAutoUpdate);

  // Refresh on open so the panel reflects the current binary (the boot/6h auto-check may be
  // stale). `refresh` has a stable identity (zustand action) → runs once per mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installed = status?.installed_version ?? null;
  const latest = status?.latest_version ?? null;
  const method = status?.install_method ?? null;
  const channel = status?.channel ?? null;
  const updateAvailable = !!status?.update_available;

  // `unknown` covers both "binary not found" and "couldn't reach the registry" — an
  // unverified version is never shown as up to date.
  const versionState = updateAvailable ? "available" : installed && latest ? "current" : "unknown";
  const detail = installed
    ? method
      ? `${method} install${channel ? ` (${channel} channel)` : ""}`
      : undefined
    : "Claude CLI not detected.";

  return (
    <>
      <SettingsGroup title="Claude Code CLI" icon="term">
        <ToggleRow
          title="Version"
          hint={
            <VersionStatus
              installed={installed}
              latest={latest}
              state={versionState}
              detail={detail}
            />
          }
          control={
            <button
              className={`${styles.btn} ${updateAvailable ? styles.primary : styles.ghost}`}
              onClick={() => void (updateAvailable ? runUpdate() : refresh())}
              disabled={updating || loading}
            >
              {updating
                ? "Updating…"
                : updateAvailable
                  ? "Update now"
                  : loading
                    ? "Checking…"
                    : "Check for updates"}
            </button>
          }
        />
        <ToggleRow
          title="Automatic updates"
          hint={
            <>
              Whether the <code>claude</code> binary updates itself in the background — the CLI's
              own auto-updater, separate from Flight Deck's above. Turn it off to pin the version
              you have. <strong>On by default.</strong>
            </>
          }
          checked={status?.auto_update_enabled ?? true}
          onChange={(v) => void setAutoUpdate(v)}
          label="Auto-update Claude Code"
        />
      </SettingsGroup>

      {updateMessage ? <div className={styles.note}>{updateMessage}</div> : null}
      {status?.config_warning ? (
        <div className={styles.hintWarn}>Config could not be read: {status.config_warning}</div>
      ) : null}
      {error ? <div className={styles.errorMsg}>{error}</div> : null}
    </>
  );
}
