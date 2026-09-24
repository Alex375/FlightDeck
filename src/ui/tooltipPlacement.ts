// Where a portaled tooltip goes, as a pure function of two rects — so the placement can be
// unit-tested without a DOM, and the component below it stays about lifecycle only.
//
// A tooltip is NOT a menu: it is centred on its trigger and prefers to sit above it, whereas
// `menuPortalPlacement` anchors a menu's edge and prefers below. Both must keep the whole box
// on-screen, so the clamping is the same idea — the preferences are not, which is why this is
// its own function rather than a flag on that one.

/** Fixed-position placement. Every side is set explicitly so a stylesheet's `top`/`left`
 *  can never leak through the inline `position:fixed`. */
export interface TooltipPos {
  left: number;
  top: number;
  /** Which side of the trigger it ended up on — the caller uses it for the entry animation. */
  side: "top" | "bottom";
}

/** Gap between the tooltip and its trigger. */
const GAP = 6;
/** Margin kept between the tooltip and the viewport edges. */
const M = 6;

/**
 * Place `tip` against `trigger`, centred horizontally and above by preference.
 *
 * Flips below only when there genuinely isn't room above — not merely when it is tighter,
 * so a tooltip near the middle of the screen doesn't jump sides as the window resizes.
 * Both axes are then clamped into the viewport, which matters most in the sidebar: a
 * trigger a few pixels from the left edge would otherwise render its tooltip half
 * off-screen, and a tooltip you cannot read is the same as no tooltip at all.
 */
export function tooltipPlacement(
  trigger: { left: number; right: number; top: number; bottom: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): TooltipPos {
  const fitsAbove = trigger.top - GAP - tip.height >= M;
  const side: "top" | "bottom" = fitsAbove ? "top" : "bottom";
  const top = fitsAbove ? trigger.top - GAP - tip.height : trigger.bottom + GAP;

  const centred = (trigger.left + trigger.right) / 2 - tip.width / 2;
  // `Math.max(M, …)` last: on a viewport narrower than the tooltip, being flush with the
  // LEFT edge beats being flush with the right (text reads from the left).
  const maxLeft = viewport.width - tip.width - M;
  const left = Math.max(M, Math.min(centred, maxLeft));

  // Same reasoning vertically for a tooltip taller than the viewport.
  const maxTop = viewport.height - tip.height - M;
  return { left, top: Math.max(M, Math.min(top, maxTop)), side };
}
