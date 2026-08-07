// The interface-zoom ladder and its pure step arithmetic, kept out of the store and the
// keyboard handler so the rules are unit-testable without a DOM.
//
// The zoom itself is applied by the OS webview (`set_ui_zoom` → `WebviewWindow::set_zoom`,
// i.e. WKWebView's `pageZoom` on macOS), NOT by CSS: the whole page scales exactly as a
// browser's ⌘+ does, so Monaco, xterm, the PDF viewer and every portalled popover keep
// working in unscaled CSS pixels and re-layout on their own (they all watch their size).
// A CSS scale would instead break the popovers that position themselves `fixed` against
// viewport coordinates, and could not reach an app drawn in fixed pixels anyway.

/** The zoom levels ⌘+ / ⌘− walk through, ascending. The browser ladder: coarse far from
 *  100 %, fine around it, so the steps feel even though the ratios are not. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** 100 % — what ⌘0 restores and what a fresh install renders at. */
export const DEFAULT_ZOOM = 1;

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Float slack for comparing a stored zoom against the ladder: 0.67 and 1.1 are not exactly
 *  representable, so `>` / `<` alone could make a step round-trip to itself. */
const EPS = 1e-6;

/**
 * A trustworthy zoom factor from anything the persisted prefs may hold: a hand-edited
 * localStorage entry, a value from an older build, `null`, a string, `NaN`. Anything that
 * isn't a finite number falls back to 100 %; a finite one is clamped to the ladder's range.
 *
 * This runs on the value BEFORE it ever reaches the webview: `setZoom(0)` or `setZoom(NaN)`
 * would leave the window unreadable with no way back short of editing storage by hand.
 */
export function sanitizeZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ZOOM;
  if (value < MIN_ZOOM) return MIN_ZOOM;
  if (value > MAX_ZOOM) return MAX_ZOOM;
  return value;
}

/** The next level up from `current`, or `current` when already at the top. Works from a value
 *  that is NOT on the ladder (an older build's step, a hand-edited pref): it picks the first
 *  step strictly above, so an off-ladder zoom snaps back onto it rather than drifting. */
export function nextZoom(current: number): number {
  const from = sanitizeZoom(current);
  return ZOOM_STEPS.find((s) => s > from + EPS) ?? MAX_ZOOM;
}

/** The next level down from `current`, or `current` when already at the bottom. Same
 *  off-ladder snapping as {@link nextZoom}. */
export function prevZoom(current: number): number {
  const from = sanitizeZoom(current);
  const below = ZOOM_STEPS.filter((s) => s < from - EPS);
  return below.length ? below[below.length - 1] : MIN_ZOOM;
}

/** The zoom as the percentage shown in Settings, e.g. `0.67` → `"67%"`. */
export function formatZoom(value: number): string {
  return `${Math.round(sanitizeZoom(value) * 100)}%`;
}
