// Dismissable banner offering to update the piloted `claude` binary when a newer version is
// published. DISTINCT from UpdateBanner, which updates the app itself. "×" dismisses the
// current version (a later release re-offers on its own); "Update" runs `claude update` in
// place — non-destructive to the app (it only swaps the binary used at the next spawn). A
// failed update surfaces INLINE here (not just in Settings). No settings toggle backs it: the
// per-version dismissal IS the off switch, and it re-arms on its own for the next release.
//
// Never TWO update strips at once: this one stands down while the APP's own update banner is
// showing (updating the app restarts it, so it outranks a CLI swap). The offer is not lost —
// Settings → Updates always has it, and the banner returns once the app one clears. (The error
// banner is a different kind of strip and may still stack; only the two UPDATE offers compete.)
// ⚠️ Standing down stops at OUR OWN work: once the user has launched a CLI update from here, the
// running/failed state stays put. Yanking the strip mid-update — or worse, right as it fails —
// would erase the only feedback the action has, at the exact surface where it was taken.
import { useClaudeCliUpdate, shouldShowClaudeCliBanner } from "../../store/claudeCliUpdate";
import { useUpdater, isUpdateBannerVisible } from "../../store/updater";
import { Ico } from "../../ui/kit";
import styles from "./ClaudeCliBanner.module.css";

export function ClaudeCliBanner() {
  const status = useClaudeCliUpdate((s) => s.status);
  const dismissedVersion = useClaudeCliUpdate((s) => s.dismissedVersion);
  const updating = useClaudeCliUpdate((s) => s.updating);
  // The UPDATE error only — a failed auto-update toggle lives in `toggleError` and stays in
  // Settings, so this banner's "Retry" can never re-run something the user didn't attempt.
  const error = useClaudeCliUpdate((s) => s.error);
  const runUpdate = useClaudeCliUpdate((s) => s.runUpdate);
  const dismiss = useClaudeCliUpdate((s) => s.dismiss);
  const appStatus = useUpdater((s) => s.status);
  const appUpdate = useUpdater((s) => s.update);

  // An update launched from the banner that failed must show its failure HERE (where the
  // action was taken), not silently revert to the plain offer — the error is only otherwise
  // visible in Settings.
  const failed = !!error && !updating;
  // Our own update is in flight or has just failed: hold the slot rather than yield it.
  const busyHere = updating || failed;

  if (!busyHere && isUpdateBannerVisible(appStatus, appUpdate)) return null;
  if (!shouldShowClaudeCliBanner(status, dismissedVersion)) return null;

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
