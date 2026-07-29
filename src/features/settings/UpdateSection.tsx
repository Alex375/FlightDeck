// "Flight Deck" card of the Updates tab: the app's own updater — current vs available
// version, release notes (rendered as Markdown), a manual check button, download progress,
// and the "install + restart" action, gated behind a relaunch confirmation so a running
// conversation is never killed by surprise. All state lives in the updater store; the in-app
// notes are the changelog part of the release body (the GitHub-only install instructions are
// stripped, see `inAppReleaseNotes`). Its twin below is ClaudeCliSection, which updates the
// piloted `claude` binary — the two share the same card + VersionStatus shape on purpose.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdater, inAppReleaseNotes } from "../../store/updater";
import { useConversationsStore } from "../../store/conversationsStore";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Ico } from "../../ui/kit";
import { SettingsGroup, ToggleRow, VersionStatus } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateSection() {
  const status = useUpdater((s) => s.status);
  const update = useUpdater((s) => s.update);
  const progress = useUpdater((s) => s.progress);
  const error = useUpdater((s) => s.error);
  const lastCheckError = useUpdater((s) => s.lastCheckError);
  const check = useUpdater((s) => s.check);
  const install = useUpdater((s) => s.install);
  // How many Claude sessions are live (a running `claude` process). Relaunching to
  // install interrupts every one of them — the confirm dialog warns about this.
  const liveSessions = useConversationsStore(
    (s) => s.conversations.filter((c) => c.handle !== null).length,
  );

  const [confirmingInstall, setConfirmingInstall] = useState(false);
  // The running app's version, so the card states what's installed even when no update is
  // pending (the updater only reports `currentVersion` alongside an available one). Null
  // outside the Tauri webview (plain browser dev server) → the row falls back to "—".
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(null));
  }, []);

  const checking = status === "checking";
  const downloading = status === "downloading" || status === "installing";
  const hasUpdate = !!update && (status === "available" || downloading);
  const notes = inAppReleaseNotes(update?.notes);

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  // What the version row states. `unknown` only while no check has landed yet (or one
  // failed) — never dressed up as "up to date".
  const versionState = hasUpdate ? "available" : status === "uptodate" ? "current" : "unknown";
  const installed = update?.currentVersion ?? appVersion;

  return (
    <>
      {/* An available update is an EVENT: announce it above the cards (motif + version jump
          + what's new). The action itself lives in the card below, so there's exactly one
          update button on the page. */}
      {hasUpdate && update ? (
        <>
          <div className={styles.updateHero}>
            <span className={styles.updateSpark}>
              <Ico name="spark" />
            </span>
            <div className={styles.updateHeroText}>
              <div className={styles.updateHeadline}>New version available</div>
              <div className={styles.versionJump}>
                <span className={styles.versionOld}>v{update.currentVersion}</span>
                <Ico name="arrow" className="sm" />
                <span className={styles.versionNew}>v{update.version}</span>
              </div>
            </div>
          </div>

          {notes ? (
            <div className={styles.notesCard}>
              <div className={styles.notesTitle}>What's new</div>
              <div className={styles.notesBody}>
                <StreamMarkdown text={notes} />
              </div>
            </div>
          ) : (
            <div className={styles.desc}>Various improvements and fixes.</div>
          )}
        </>
      ) : null}

      <SettingsGroup title="Flight Deck" icon="spark">
        <ToggleRow
          title="Version"
          hint={
            <VersionStatus
              installed={installed}
              latest={update?.version}
              state={versionState}
              detail={
                status === "error"
                  ? "The last check failed."
                  : lastCheckError
                    ? `Last automatic check failed: ${lastCheckError}`
                    : undefined
              }
            />
          }
          control={
            hasUpdate ? (
              <button
                className={`${styles.btn} ${styles.primary} ${styles.btnUpdate}`}
                onClick={() => setConfirmingInstall(true)}
                disabled={downloading}
              >
                <Ico name="refresh" className="sm" />
                {status === "installing"
                  ? "Restarting…"
                  : status === "downloading"
                    ? "Downloading…"
                    : error
                      ? "Retry installation"
                      : "Update and restart"}
              </button>
            ) : (
              <button
                className={`${styles.btn} ${styles.ghost}`}
                onClick={() => void check()}
                disabled={checking}
              >
                {checking ? "Checking…" : "Check for updates"}
              </button>
            )
          }
        />

        {downloading && progress ? (
          <div className={styles.trow}>
            <div className={styles.ttext}>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: pct != null ? `${pct}%` : "100%" }}
                />
              </div>
              <div className={styles.progressLabel}>
                {status === "installing"
                  ? "Installing, restarting soon…"
                  : progress.total
                    ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}${
                        pct != null ? ` (${pct}%)` : ""
                      }`
                    : `${formatBytes(progress.downloaded)}…`}
              </div>
            </div>
          </div>
        ) : null}
      </SettingsGroup>

      {error ? <div className={styles.errorMsg}>{error}</div> : null}

      {/* Relaunch confirmation — ALWAYS shown before installing, because installing
          relaunches the app and drops every live session. Reinforced (danger + count
          + "Wait") when conversations are actually running. */}
      <ConfirmDialog
        open={confirmingInstall}
        danger={liveSessions > 0}
        title="Update Flight Deck?"
        confirmLabel={liveSessions > 0 ? "Update now" : "Update and restart"}
        cancelLabel={liveSessions > 0 ? "Wait" : "Cancel"}
        onCancel={() => setConfirmingInstall(false)}
        onConfirm={() => {
          setConfirmingInstall(false);
          void install();
        }}
      >
        The app will <strong>restart</strong> to install
        {update ? ` version ${update.version}` : " the update"}.
        {liveSessions > 0 ? (
          <>
            {" "}
            <strong>
              {liveSessions} running conversation{liveSessions > 1 ? "s" : ""}
            </strong>{" "}
            will be interrupted — unfinished work may be lost. You can{" "}
            <strong>wait</strong> for {liveSessions > 1 ? "them to finish" : "it to finish"}{" "}
            before updating.
          </>
        ) : (
          " No conversations are running."
        )}
      </ConfirmDialog>
    </>
  );
}
