// Global "update available" indicator. Appears at the top of the app whenever a
// newer signed version has been detected (launch / 2h auto-check / manual check).
// Clicking it opens Settings on the "Updates" section — where the user can
// read the notes and install. Stays until the app is updated.
import { useUpdater, isUpdateBannerVisible } from "../../store/updater";
import { useSettingsUi } from "../../store/settingsUi";
import { Ico } from "../../ui/kit";
import styles from "./UpdateBanner.module.css";

export function UpdateBanner() {
  const status = useUpdater((s) => s.status);
  const update = useUpdater((s) => s.update);
  const openSettings = useSettingsUi((s) => s.openSettings);

  // Shared with ClaudeCliBanner, which stands down while this one shows (see the predicate).
  if (!isUpdateBannerVisible(status, update) || !update) return null;

  const label =
    status === "installing"
      ? "Installing update…"
      : status === "downloading"
        ? "Downloading update…"
        : `Update available — v${update.version}`;

  return (
    <button
      type="button"
      className={styles.banner}
      onClick={() => openSettings("updates")}
      title="Open update settings"
    >
      <Ico name="spark" className="sm" />
      <span className={styles.label}>{label}</span>
      {status === "available" ? <span className={styles.cta}>Install →</span> : null}
    </button>
  );
}
