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
  const toggleError = useClaudeCliUpdate((s) => s.toggleError);
  const refresh = useClaudeCliUpdate((s) => s.refresh);
  const runUpdate = useClaudeCliUpdate((s) => s.runUpdate);
  const setAutoUpdate = useClaudeCliUpdate((s) => s.setAutoUpdate);

  // Refresh on open so the panel reflects the current binary (the boot/6h auto-check may be
  // stale). `refresh` has a stable identity (zustand action) → runs once per mount. Reopening
  // Settings also clears a stale toggle error: it belongs to an action taken in a previous
  // visit, and nothing else would ever drop it once the switch is disabled.
  useEffect(() => {
    useClaudeCliUpdate.setState({ toggleError: null });
    void refresh();
  }, [refresh]);

  const installed = status?.installed_version ?? null;
  const latest = status?.latest_version ?? null;
  const method = status?.install_method ?? null;
  const channel = status?.channel ?? null;
  const updateAvailable = !!status?.update_available;
  // Auto-update held off by `~/.claude.json` — a gate our toggle cannot open (see the Rust
  // `auto_update_locked`). Unknown status → NOT locked, so we never grey out a working control.
  const locked = !!status?.auto_update_locked;

  // `unknown` covers both "binary not found" and "couldn't reach the registry" — an
  // unverified version is never shown as up to date.
  const versionState = updateAvailable ? "available" : installed && latest ? "current" : "unknown";
  // ⚠️ "not detected" is a CLAIM, and we may only make it once a probe has actually answered.
  // Before the first status lands (the check is deferred at boot, and this panel's own mount
  // refresh takes a moment) `status` is null — that is "not checked yet", which the version row
  // already says as "Unknown". Asserting "not detected" there tells the user their CLI is
  // missing when we simply have not looked.
  const detail = installed
    ? method
      ? `${method} install${channel ? ` (${channel} channel)` : ""}`
      : undefined
    : status
      ? "Claude CLI not detected."
      : undefined;

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
            locked ? (
              // No CLI command is offered here on purpose: `claude` 2.1.220 has no `config`
              // subcommand (verified against `claude --help`), so naming one would send the user
              // to a dead end. The file path is the honest, checkable instruction.
              <>
                Auto-update is turned off in the CLI's own configuration —{" "}
                <code>"autoUpdates": false</code> in <code>~/.claude.json</code>, a file Flight Deck
                never writes because it belongs to <code>claude</code>. Set it back to{" "}
                <code>true</code> there and this switch will follow.
              </>
            ) : (
              <>
                Whether the <code>claude</code> binary updates itself in the background — the CLI's
                own auto-updater, separate from Flight Deck's above. Turn it off to pin the version
                you have. <strong>On by default.</strong>
              </>
            )
          }
          checked={status?.auto_update_enabled ?? true}
          onChange={(v) => void setAutoUpdate(v)}
          label="Auto-update Claude Code"
          // The switch only drives `DISABLE_AUTOUPDATER`. When the OTHER gate holds auto-update
          // off, flipping it would appear to work and then spring back at the next read — so
          // disable it, with the reason in the visible hint above (a disabled control shows no
          // tooltip), rather than offer a control that silently does nothing.
          disabled={locked}
        />
      </SettingsGroup>

      {updateMessage ? <div className={styles.note}>{updateMessage}</div> : null}
      {status?.config_warning ? (
        <div className={styles.hintWarn}>Config could not be read: {status.config_warning}</div>
      ) : null}
      {error ? <div className={styles.errorMsg}>{error}</div> : null}
      {toggleError ? <div className={styles.errorMsg}>{toggleError}</div> : null}
    </>
  );
}
