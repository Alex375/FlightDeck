// Telling VISUAL pixels from LAYOUT pixels.
//
// `getBoundingClientRect()` reports what is PAINTED: a `transform` on any ancestor scales
// everything it returns. `offsetTop`/`offsetHeight`/`scrollTop` report LAYOUT, which no
// transform can touch. Mixing the two is silent and only shows up as things landing in the
// wrong place — the two spaces are identical right up until something animates a transform,
// so the bug ships long before it is reachable.
//
// The Flight Deck's reply modal made that hazard reachable app-wide: it opens by transforming
// the panel up from a card's box, and everything inside it — the conversation pane, its
// thread, the minimap — measures itself during those frames. Anything that CACHES such a
// measurement keeps the wrong value for good, because a transform changes no layout box and
// so wakes no ResizeObserver.
//
// The rule these helpers exist to make cheap: pick a space, convert at the boundary. Divide a
// visual measurement by the scale to get layout pixels; multiply a layout constant by it to
// compare against visual ones.

/**
 * The vertical scale an ancestor `transform` is currently painting `el` at, from its visual
 * height against its layout height. 1 when nothing is scaling it.
 *
 * Ratios within a hair of 1 snap to exactly 1: `offsetHeight` is integer-rounded, so at rest
 * the ratio lands a fraction off, and the untransformed case must divide by nothing at all
 * rather than by 1.0004.
 */
export function verticalScaleOf(visualHeight: number, layoutHeight: number): number {
  if (!(layoutHeight > 0) || !Number.isFinite(visualHeight)) return 1;
  const scale = visualHeight / layoutHeight;
  if (!(scale > 0) || !Number.isFinite(scale)) return 1;
  return Math.abs(scale - 1) < 0.01 ? 1 : scale;
}

/** {@link verticalScaleOf} for a live element — the reading every call site actually wants. */
export function verticalScaleOfEl(el: HTMLElement | null | undefined): number {
  if (!el) return 1;
  return verticalScaleOf(el.getBoundingClientRect().height, el.offsetHeight);
}
