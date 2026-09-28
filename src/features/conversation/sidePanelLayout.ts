// Geometry of the conversation side panel — pure, so the "does it fit?" rule is testable.
//
// The panel is a resizable column at the far right of the conversation view. It must never
// crush the conversation below the width its composer needs, nor the editor/terminal region
// below its own floor. When the three cannot sit side by side, the panel stops PUSHING the
// layout and floats OVER the right edge instead (its open/closed state is untouched: an open
// panel stays visible, it just stops taking room).

import { MIN_CONVERSATION_PANE_PX } from "./composerLayout";

/**
 * Every width here is the width of the panel's SLOT — the 6px splitter that drags it included,
 * since the splitter lives inside the animated slot (so the divider slides in with the panel)
 * and therefore counts against the same budget. Mirrors {@link SIDE_REGION_MIN_PX}.
 */

/** Default width of the conversation side panel, px — what it opens at before anyone drags it. */
export const SIDE_PANEL_PX = 340;

/**
 * Narrowest the panel may be dragged to.
 *
 * 280px of sheet + the 6px splitter + the sheet's floating insets (2px left, 8px right — see
 * `.panel` in ConversationSidePanel.module.css; change one, change the other). The floor is set
 * by the panel's own rows, not by taste: at 280 the header still holds its title pill and the
 * close button; the session footer's rows still fit an icon, a two-line label and their two
 * 26px buttons; and the TOSSE card's status chip and assignee picker still share one line.
 */
export const SIDE_PANEL_MIN_PX = 296;

/** Widest the panel may be dragged to. Past this it stops being a column of status and starts
 *  eating the thread, which is the surface the window is for. */
export const SIDE_PANEL_MAX_PX = 560;

/** Narrowest the editor/terminal side region may be dragged to: the 280px the panel itself
 *  needs, plus the 6px splitter — which lives INSIDE the animated slot (so the divider slides
 *  in with the panel), and therefore counts against the same minimum. */
export const SIDE_REGION_MIN_PX = 286;

/** How much of `areaPx` is left for the panel once the conversation — and the editor/terminal/
 *  Git region when it is open — keep their floors. May be negative. */
export function sidePanelRoom(areaPx: number, sideRegionOpen: boolean): number {
  return areaPx - MIN_CONVERSATION_PANE_PX - (sideRegionOpen ? SIDE_REGION_MIN_PX : 0);
}

/**
 * Whether the side panel can DOCK (take its own column) in an area `areaPx` wide — the width
 * shared by the conversation, the editor/terminal/Git region when it is open, and the panel.
 *
 * The test is against the panel's MINIMUM, not its current width: a window with room for a
 * narrow panel docks a narrow panel rather than floating a wide one over the thread. What it
 * then actually gets is {@link dockedSidePanelWidth}.
 *
 * `sideRegionOpen` must be true whenever that region shows ANYTHING (editor, terminal, Git,
 * an artifact or a TOSSE task): each of them claims its floor next to the conversation.
 */
export function sidePanelDocks(areaPx: number, sideRegionOpen: boolean): boolean {
  return sidePanelRoom(areaPx, sideRegionOpen) >= SIDE_PANEL_MIN_PX;
}

/** A width the user asked for, held inside the panel's own bounds. What gets PERSISTED — it
 *  must not depend on the window that happened to be open when the drag ended. */
export function clampSidePanelWidth(desiredPx: number): number {
  if (!Number.isFinite(desiredPx)) return SIDE_PANEL_PX;
  return Math.min(SIDE_PANEL_MAX_PX, Math.max(SIDE_PANEL_MIN_PX, Math.round(desiredPx)));
}

/**
 * The width a DOCKED panel actually gets: what the user asked for, capped by the room left
 * beside the conversation and the side region. Never below the panel's floor — below it the
 * panel doesn't dock at all ({@link sidePanelDocks}), so clamping up here is what keeps a
 * shrinking window from rendering a squashed column for the frame before it floats.
 */
export function dockedSidePanelWidth(
  desiredPx: number,
  areaPx: number,
  sideRegionOpen: boolean,
): number {
  const want = clampSidePanelWidth(desiredPx);
  return Math.max(SIDE_PANEL_MIN_PX, Math.min(want, sidePanelRoom(areaPx, sideRegionOpen)));
}

/** The width a FLOATING panel gets: the same request, capped only by the window itself (it
 *  overlays the thread rather than sharing the row, so the conversation's floor doesn't apply
 *  — but a panel wider than the area would hang off the edge). */
export function floatingSidePanelWidth(desiredPx: number, areaPx: number): number {
  return Math.min(clampSidePanelWidth(desiredPx), Math.max(0, areaPx));
}

/**
 * Fit-content mode (`sidePanelFitContent`): the panel is a sheet at the top right, only as tall
 * as what it holds. These are the rules for its HEIGHT — the DOM side lives in useFitHeight.
 */

/** How long the sheet takes to grow into new content, ms. Slightly longer than a panel's slide
 *  in: it reveals a section, so the eye has to land on what appeared. */
export const FIT_GROW_MS = 240;
/** How long it takes to shrink back once a section goes. */
export const FIT_SHRINK_MS = 200;

/** One reading of a fit-content panel, in CSS px. */
export interface FitMeasure {
  /** The height the panel would take to show everything — header, sections, footer. */
  natural: number;
  /** The most it may take: its host's height, minus the sheet's own vertical margins. */
  avail: number;
  /** Its width — a change here re-wraps the text, which is a relayout, not new content. */
  width: number;
}

/**
 * What a fit-content panel does with a new reading: the height to set, and whether to get there
 * by animating. `null` → nothing to do.
 *
 * The height is the content's, capped by the room (past it the sections scroll). Only a change
 * of CONTENT animates — a section arriving or leaving at the same width. The first placement,
 * a window resize and a width drag are all relayouts: an animated height there would trail
 * behind the pointer or the window edge instead of following it.
 */
export function fitHeightStep(
  prev: FitMeasure | null,
  next: FitMeasure,
): { height: number; animate: boolean } | null {
  const height = fitHeight(next);
  if (prev && Math.abs(height - fitHeight(prev)) < 1) return null;
  const contentMoved =
    prev !== null &&
    Math.abs(next.natural - prev.natural) >= 1 &&
    Math.abs(next.width - prev.width) < 1 &&
    Math.abs(next.avail - prev.avail) < 1;
  return { height, animate: contentMoved };
}

/** The height a reading settles at: the content's, never past the room, never negative. The
 *  content is rounded UP — a fractional line box rounded down would overflow by a hair and
 *  summon a scrollbar over a panel that fits. */
function fitHeight({ natural, avail }: FitMeasure): number {
  return Math.max(0, Math.min(Math.ceil(natural), Math.floor(avail)));
}
