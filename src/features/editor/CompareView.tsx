// A comparison tab (`openCompare`): two files side by side in the Git panel's ribbon diff
// — the old version on the left, the new one on the right. Read-only; both sides follow
// the disk like any open file (see the store's `readCompare`).

import { lazy, Suspense } from "react";
import { Ico } from "../../ui/kit";
import type { CompareSide } from "./editorStore";
import styles from "./editor.module.css";

// Monaco's diff editor — its own chunk, shared with the Git panel (DiffSlot).
const RibbonDiff = lazy(() => import("../git/RibbonDiff"));

/** A path as the bar shows it: relative to the editor's folder when it lies inside. */
function shown(path: string, root: string): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

export function CompareView({
  left,
  right,
  root,
  loading,
}: {
  left: CompareSide;
  right: CompareSide;
  root: string;
  loading: boolean;
}) {
  const failed = [
    left.error ? { side: "Left", ...left } : null,
    right.error ? { side: "Right", ...right } : null,
  ].filter((s) => s !== null);
  const identical = !loading && failed.length === 0 && left.text === right.text;

  return (
    <>
      <div className={styles.toolbar}>
        <Ico name="diff" className="sm" />
        <span className={styles.comparePath} title={left.path}>
          {shown(left.path, root)}
        </span>
        <span className={styles.compareArrow}>→</span>
        <span className={styles.comparePath} title={right.path}>
          {shown(right.path, root)}
        </span>
        <span className={styles.toolbarSpace} />
        {identical ? <span>Identical</span> : null}
      </div>
      {loading ? (
        <div className={styles.placeholder}>Loading…</div>
      ) : failed.length > 0 ? (
        <div className={styles.placeholder}>
          <div>
            {failed.map((s) => (
              <div key={s.side}>
                {s.side} file <code className={styles.compareCode}>{s.path}</code>: {s.error}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Suspense fallback={<div className={styles.placeholder}>Loading diff…</div>}>
          <RibbonDiff path={right.path} oldText={left.text} newText={right.text} />
        </Suspense>
      )}
    </>
  );
}
