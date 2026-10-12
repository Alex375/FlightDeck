import { Ico } from "../../ui/kit";
import styles from "../editor/editor.module.css";

/**
 * What a side-region pane shows INSTEAD of itself for a conversation on a paired server: the
 * editor (tree + file reads + fs watch), the integrated terminal (a local PTY) and the Git views
 * (this Mac's `git`) all work on THIS Mac's disk, which holds nothing of that conversation — or
 * worse, an unrelated clone at the same path. The pane is still opened by its usual toggle (the
 * toggles are layout-wide, shared by every conversation), so it explains itself in place rather
 * than staying blank; nothing behind it is mounted, so no read, watch or shell ever starts.
 */
export function RemotePaneNote({
  icon,
  reason,
  stacked,
  onClose,
  closeLabel,
}: {
  /** A `kit` icon name, the pane's own (code / term / branch). */
  icon: string;
  /** The refusal, naming the server (see `store/remoteGates.ts`). */
  reason: string;
  /** Same divider edge as the pane it replaces (left beside the conversation, top below it). */
  stacked: boolean;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <div className={styles.panel + (stacked ? " " + styles.panelStacked : "")} role="note">
      <div className={styles.placeholder} style={{ flexDirection: "column", gap: 12 }}>
        <Ico name={icon} />
        <p style={{ margin: 0, maxWidth: "42ch" }}>{reason}</p>
        <button type="button" className="cv-artview-open" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
    </div>
  );
}
