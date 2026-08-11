// A small modal confirmation, for actions that need a deliberate yes/no before
// they run (e.g. deleting a conversation). Renders nothing when closed. Escape
// or a click on the scrim cancels; the confirm button is focused so Enter on it
// confirms — Enter is intentionally NOT bound globally, so a stray keypress can't
// trigger a destructive action.
//
// Rendered through a portal to `document.body`: the dialog is invoked from deep
// inside the sidebar, whose ancestors establish their own stacking/containing
// contexts. Without the portal the fixed scrim is trapped under (and clipped to)
// the sidebar and the conversation panel paints over it. At the body level it
// covers the whole window, above everything.
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./ConfirmDialog.module.css";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  busy,
  size = "default",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
  /**
   * `"lg"` for a body that is more than a sentence — a wider, airier panel. Opt-in so the
   * many one-line confirmations across the app keep the compact panel they were written for.
   */
  size?: "default" | "lg";
  /** Disable the buttons while the action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      // Own Escape while open: stopPropagation so an outer window-level Escape handler
      // (e.g. the Settings panel, which closes on bare Escape) doesn't ALSO fire — one
      // Escape closes exactly one layer (the repo's "topmost layer claims Escape"
      // convention). We listen on `document` (bubble), so stopping here keeps the key
      // from reaching `window`; the app-wide capture guard in App.tsx owns the
      // fullscreen preventDefault, so we don't repeat it.
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className={styles.scrim} onClick={onCancel}>
      <div
        className={`${styles.panel} ${size === "lg" ? styles.lg : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal
      >
        <div className={styles.title}>{title}</div>
        {children ? <div className={styles.body}>{children}</div> : null}
        <div className={styles.actions}>
          <button
            className={`${styles.btn} ${styles.ghost}`}
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            className={`${styles.btn} ${danger ? styles.danger : styles.primary}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
