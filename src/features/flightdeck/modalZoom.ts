// Geometry for the Flight Deck reply modal's "Quick Look" zoom: opening a card grows the
// panel OUT of that card, closing it shrinks the panel BACK into wherever that card is now.
// This is the FLIP trick — the panel is always laid out at its final size and position, and
// only a `transform` (composited, no reflow) plays it back from the card.
//
// Everything here is PURE so the maths is locked by tests: an animation that lands a few
// pixels off, or that flies in from a card scrolled off-screen, reads as a bug rather than
// as a flourish. The guards return `null` for every case where a zoom would be nonsense
// (no origin, a card that has no box, a card entirely outside the window) — the caller then
// falls back to a plain fade, which is honest: it says "this appeared" without lying about
// where from.

/** A screen-space box, in CSS pixels (the subset of DOMRect this module needs). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How long the panel takes to grow out of the card. Short on purpose: this animation sits
 *  between the user and the answer they clicked to read. */
export const ZOOM_IN_MS = 210;
/** …and to shrink back into it. Shorter still — leaving should feel instant. */
export const ZOOM_OUT_MS = 150;

/** Decelerating, but not violently so. A sharper curve (easeOutExpo & friends) covers half
 *  the distance in the first tenth of the duration, which reads as the panel BLINKING to
 *  full size rather than leaving the card — the take-off is the part that carries the
 *  meaning here, so it gets frames spent on it. */
export const EASE_OPEN = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Accelerating: peels away slowly, then drops into the card. */
export const EASE_CLOSE = "cubic-bezier(0.4, 0, 0.9, 0.5)";

/** The scale a degenerate origin is never allowed to go below — a 0-height card would
 *  otherwise collapse the panel to an invisible line and "unfold" out of nothing. */
const MIN_SCALE = 0.04;

const round = (n: number, d = 3): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const finiteBox = (b: Box | null | undefined): b is Box =>
  !!b &&
  Number.isFinite(b.left) &&
  Number.isFinite(b.top) &&
  Number.isFinite(b.width) &&
  Number.isFinite(b.height) &&
  b.width > 0 &&
  b.height > 0;

/** The live screen box of an element, or `null` when there is no element. Note a detached or
 *  hidden element still yields a box — an all-zero one — which {@link zoomTransform} rejects
 *  on its own, so callers can chain a fallback origin behind it. */
export function boxOf(el: Element | null | undefined): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Does this box overlap the window at all? A card scrolled out of its swimlane keeps a
 *  perfectly valid (but off-screen) box; zooming to it would throw the panel across the
 *  screen towards something the user cannot see. */
export function isOnScreen(box: Box, viewport: { width: number; height: number }): boolean {
  return (
    box.left < viewport.width &&
    box.top < viewport.height &&
    box.left + box.width > 0 &&
    box.top + box.height > 0
  );
}

/**
 * The CSS `transform` that maps `panel` (laid out at its final size) onto `origin` — i.e.
 * the animation's *card* end. Animate to/from `"none"` for the *panel* end.
 *
 * Returns `null` when no honest zoom exists: no origin, a degenerate box, or a card that is
 * entirely off-screen. The scale is clamped to `≤ 1` so a card somehow larger than the panel
 * never plays the animation backwards (shrinking INTO the modal).
 */
export function zoomTransform(
  origin: Box | null | undefined,
  panel: Box | null | undefined,
  viewport: { width: number; height: number },
): string | null {
  if (!finiteBox(origin) || !finiteBox(panel)) return null;
  if (!isOnScreen(origin, viewport)) return null;
  const sx = clamp(origin.width / panel.width, MIN_SCALE, 1);
  const sy = clamp(origin.height / panel.height, MIN_SCALE, 1);
  // Centre-to-centre, because the transform-origin is the panel's centre.
  const dx = origin.left + origin.width / 2 - (panel.left + panel.width / 2);
  const dy = origin.top + origin.height / 2 - (panel.top + panel.height / 2);
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(sx, 4)}, ${round(sy, 4)})`;
}
