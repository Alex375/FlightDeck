// Where a dragged dock would land — the pure half of "drag the panel to the bottom or to
// the right". No DOM, no React: a rectangle (the editor + dock area) and a pointer, in,
// a drop zone out. The overlay draws its zones from the SAME share constant, so what the
// user aims at and what the hit-test answers can never drift apart.

import type { DockPosition } from "./ideStore";

/** A drop target. The two are exactly the dock's two positions, so a drop result goes
 *  straight into `setDockPosition`. */
export type DockZone = DockPosition;

/** How much of the area each zone claims, along its own axis: the right 40% of the width,
 *  the bottom 40% of the height. Big enough to aim at without care, small enough to leave
 *  a neutral middle that means "cancel". */
export const DOCK_ZONE_SHARE = 0.4;

/** How far the pointer must travel before a press on the grip becomes a drag. Same 6px as
 *  the conversation/repo reordering (`ui/orderDnd.ts`), so "click" and "drag" feel alike
 *  everywhere in the app. */
export const DOCK_DRAG_THRESHOLD_PX = 6;

/** The area the zones are measured against — a `DOMRect` fits as-is. */
export interface DockArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The zone a pointer at (x, y) is over, or null when it is over neither (the neutral
 * middle, or outside the area entirely — a release there cancels).
 *
 * The two zones overlap in the bottom-right corner. The winner there is the one the
 * pointer has gone DEEPER into, measured as a share of that zone's own band rather than
 * in pixels: the area is usually much wider than it is tall, and raw pixels would hand the
 * whole corner to the wider axis. An exact tie (the corner's diagonal) resolves to
 * "right", so the function is total and deterministic.
 */
export function dockZoneAt(rect: DockArea, x: number, y: number): DockZone | null {
  const { left, top, width, height } = rect;
  // A zero-size (or not-yet-laid-out) area has no zones — every point is "outside". Written
  // as `!(… > 0)` so a NaN width answers null rather than sliding through a `<=` test.
  if (!(width > 0) || !(height > 0)) return null;

  const dx = x - left;
  const dy = y - top;
  if (dx < 0 || dy < 0 || dx > width || dy > height) return null;

  // 0 = the pointer has just entered the band, 1 = it is pinned to the far edge; negative
  // = it is not in that band at all.
  const intoRight = (dx / width - (1 - DOCK_ZONE_SHARE)) / DOCK_ZONE_SHARE;
  const intoBottom = (dy / height - (1 - DOCK_ZONE_SHARE)) / DOCK_ZONE_SHARE;
  if (intoRight < 0 && intoBottom < 0) return null;
  return intoBottom > intoRight ? "bottom" : "right";
}

/** Whether a press has travelled far enough to count as a drag rather than a click.
 *  Euclidean, like the reordering sensor: a diagonal nudge is a nudge on both axes. */
export function exceedsDragThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DOCK_DRAG_THRESHOLD_PX;
}
