// Geometry of the conversation side panel — pure, so the "does it fit?" rule is testable.
//
// The panel is a fixed-width column at the far right of the conversation view. It must never
// crush the conversation below the width its composer needs, nor the editor/terminal region
// below its own floor. When the three cannot sit side by side, the panel stops PUSHING the
// layout and floats OVER the right edge instead (its open/closed state is untouched: an open
// panel stays visible, it just stops taking room).

import { MIN_CONVERSATION_PANE_PX } from "./composerLayout";

/** Width of the conversation side panel, px. */
export const SIDE_PANEL_PX = 340;

/** Narrowest the editor/terminal side region may be dragged to: the 280px the panel itself
 *  needs, plus the 6px splitter — which lives INSIDE the animated slot (so the divider slides
 *  in with the panel), and therefore counts against the same minimum. */
export const SIDE_REGION_MIN_PX = 286;

/**
 * Whether the side panel can DOCK (take its own column) in an area `areaPx` wide — the width
 * shared by the conversation, the editor/terminal/Git region when it is open, and the panel.
 *
 * `sideRegionOpen` must be true whenever that region shows ANYTHING (editor, terminal, Git,
 * an artifact or a TOSSE task): each of them claims its floor next to the conversation.
 */
export function sidePanelDocks(areaPx: number, sideRegionOpen: boolean): boolean {
  const needed =
    MIN_CONVERSATION_PANE_PX + (sideRegionOpen ? SIDE_REGION_MIN_PX : 0) + SIDE_PANEL_PX;
  return areaPx >= needed;
}
