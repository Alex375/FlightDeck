// "Claude Code CLI" sub-section of the Updates tab: the piloted `claude` binary's version,
// a check/update button, its background auto-updater toggle, and the update-banner switch.
// This is a SECOND updater — distinct from UpdateSection above it, which updates Flight Deck
// (the app) itself.
import { useEffect } from "react";
import { useClaudeCliUpdate } from "../../store/claudeCliUpdate";
import { useDisplay } from "../../store/display";
import { SettingsGroup, ToggleRow } from "./SettingsKit";
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
  const showBanner = useDisplay((s) => s.showClaudeCliBanner);
  const setDisplay = useDisplay((s) => s.set);

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

  const versionHint = (
    <>
      {installed ? (
        <>
          Installed: <strong>v{installed}</strong>
        </>
      ) : (
        "Claude CLI not detected."
      )}
      {updateAvailable && latest ? (
        <>
          {" — "}
          <strong>v{latest}</strong> available.
        </>
      ) : installed && latest ? (
        " — up to date."
      ) : null}
      {method ? (
        <>
          {" · "}
          {method} install{channel ? ` (${channel} channel)` : ""}.
        </>
      ) : null}
    </>
  );

  const buttonLabel = updating
    ? "Updating…"
    : updateAvailable
      ? "Update now"
      : loading
        ? "Checking…"
        : "Check for updates";

  return (
    <SettingsGroup title="Claude Code CLI" icon="refresh">
      <ToggleRow
        title="Automatic updates"
        hint={
          <>
            Whether the <code>claude</code> binary updates itself in the background (the CLI's
            own auto-updater — separate from Flight Deck's updates above). A native install
            keeps itself current; turn this off to pin the version you have.{" "}
            <strong>On by default.</strong>
          </>
        }
        checked={status?.auto_update_enabled ?? true}
        onChange={(v) => void setAutoUpdate(v)}
        label="Auto-update Claude Code"
      />
      <ToggleRow
        title="Version"
        hint={versionHint}
        control={
          <button
            className={`${styles.btn} ${updateAvailable ? styles.primary : styles.ghost}`}
            onClick={() => void (updateAvailable ? runUpdate() : refresh())}
            disabled={updating || loading}
          >
            {buttonLabel}
          </button>
        }
      />
      <ToggleRow
        title="Update banner"
        hint={
          <>
            Show a dismissable banner at the top of the app when a newer Claude Code version is
            available. <strong>On by default.</strong> Off → check and update from here instead.
          </>
        }
        checked={showBanner}
        onChange={(v) => setDisplay({ showClaudeCliBanner: v })}
        label="Show Claude CLI update banner"
      />
      {updateMessage ? <div className={styles.note}>{updateMessage}</div> : null}
      {status?.config_warning ? (
        <div className={styles.hintWarn}>Config could not be read: {status.config_warning}</div>
      ) : null}
      {error ? <div className={styles.errorMsg}>{error}</div> : null}
    </SettingsGroup>
  );
}
