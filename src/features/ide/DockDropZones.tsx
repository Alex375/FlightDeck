// What a dock drag looks like: the two places the panel can land, drawn over the editor and
// the dock for as long as the pointer is down.
//
// The zones are laid out from `DOCK_ZONE_SHARE`, the very constant `dockZoneAt` hit-tests
// with, so the target the user aims at IS the target that answers. The overlay takes no
// pointer events — it is a picture of the drag, never a participant in it.

import { Ico } from "../../ui/kit";
import { DOCK_ZONE_SHARE, type DockZone } from "./dockDrag";
import type { DockPosition } from "./ideStore";
import styles from "./ide.module.css";

/**
 * The drop-zone overlay. `hot` is the zone under the pointer (null over the neutral
 * middle), `current` the position the dock holds right now — marked, so dropping on it
 * reads as "leave it where it is" rather than as a move that did nothing.
 *
 * Mount it only while a drag is active; it is a sibling of the editor and dock inside the
 * split container, which is what it measures itself against.
 */
export function DockDropZones({ hot, current }: { hot: DockZone | null; current: DockPosition }) {
  const size = `${Math.round(DOCK_ZONE_SHARE * 100)}%`;
  return (
    // Hidden from assistive tech: this is the mouse half of a move that is also a plain
    // button in the dock header ("Move the panel"), which is the path a keyboard or screen
    // reader takes.
    <div className={styles.dropOverlay} aria-hidden="true">
      <div className={styles.dropHint}>Drop on a zone to move the panel · Esc to cancel</div>
      <Zone zone="bottom" hot={hot} current={current} style={{ height: size }} />
      {/* Second, so the corner where the two overlap paints the right-hand one on top —
          the same zone the corner's tie-break hands a dead-centre drop to. */}
      <Zone zone="right" hot={hot} current={current} style={{ width: size }} />
    </div>
  );
}

const ZONE_LABEL: Record<DockZone, string> = { bottom: "Bottom", right: "Right" };
// The header's own language for the two layouts: a horizontal rule for a panel underneath,
// a vertical one for a panel beside.
const ZONE_ICON: Record<DockZone, string> = { bottom: "splitv", right: "splith" };

function Zone({
  zone,
  hot,
  current,
  style,
}: {
  zone: DockZone;
  hot: DockZone | null;
  current: DockPosition;
  style: React.CSSProperties;
}) {
  return (
    <div
      className={styles.dropZone}
      data-zone={zone}
      data-hot={hot === zone ? "" : undefined}
      data-current={current === zone ? "" : undefined}
      style={style}
    >
      <span className={styles.dropChip}>
        <Ico name={ZONE_ICON[zone]} className="sm" />
        {ZONE_LABEL[zone]}
        {current === zone ? <span className={styles.dropCurrent}>current</span> : null}
      </span>
    </div>
  );
}
