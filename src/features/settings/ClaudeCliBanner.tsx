// Dismissable banner offering to update the piloted `claude` binary when a newer version is
// published. DISTINCT from UpdateBanner, which updates the app itself. "×" dismisses the
// current version (a later release re-offers on its own); "Update" runs `claude update` in
// place — non-destructive to the app (it only swaps the binary used at the next spawn). A
// failed update surfaces INLINE here (not just in Settings), and the whole banner can be
// turned off persistently via the `showClaudeCliBanner` display pref.
import { useClaudeCliUpdate, shouldShowClaudeCliBanner } from "../../store/claudeCliUpdate";
import { useDisplay } from "../../store/display";
import { Ico } from "../../ui/kit";
import styles from "./ClaudeCliBanner.module.css";

export function ClaudeCliBanner() {
  const status = useClaudeCliUpdate((s) => s.status);
  const dismissedVersion = useClaudeCliUpdate((s) => s.dismissedVersion);
  const updating = useClaudeCliUpdate((s) => s.updating);
  const error = useClaudeCliUpdate((s) => s.error);
  const runUpdate = useClaudeCliUpdate((s) => s.runUpdate);
  const dismiss = useClaudeCliUpdate((s) => s.dismiss);
  const enabled = useDisplay((s) => s.showClaudeCliBanner);

  if (!enabled || !shouldShowClaudeCliBanner(status, dismissedVersion)) return null;

  // An update launched from the banner that failed must show its failure HERE (where the
  // action was taken), not silently revert to the plain offer — the error is only otherwise
  // visible in Settings.
  const failed = !!error && !updating;

  return (
    <div className={styles.banner} role="status">
      <Ico name="spark" className="sm" />
      <span className={styles.label}>
        {updating
          ? "Updating Claude Code…"
          : failed
            ? `Update failed: ${error}`
            : `Claude Code v${status!.latest_version} available`}
      </span>
      {!updating && (
        <>
          <button type="button" className={styles.cta} onClick={() => void runUpdate()}>
            {failed ? "Retry →" : "Update →"}
          </button>
          <button
            type="button"
            className={styles.dismiss}
            onClick={dismiss}
            title="Dismiss"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
