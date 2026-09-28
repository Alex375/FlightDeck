// The conversation's READING COLUMN width — the thread's text and the composer share one
// centred column (`--cv-max`, see `.cv-pane` in conductor-conversation.css), and this is the
// user's cap on it (`conversationWidth` display pref).
//
// Only the CAP lives here. The side margin that keeps the column off the pane's edges when the
// pane is narrower than the cap is CSS (`--cv-gutter`): it depends on the pane's live width,
// which only the stylesheet sees without measuring.

/** What a fresh install renders at. Down from the historical 840: with both side bars open the
 *  column used to fill the pane edge to edge. */
export const DEFAULT_READING_WIDTH = 760;
/** The narrowest cap offered — still a comfortable line of prose, and above the composer's own
 *  floor (MIN_COMPOSER_PX), so no setting can make the composer compact itself. */
export const MIN_READING_WIDTH = 560;
/** The widest — past this a line of prose is too long to read comfortably. */
export const MAX_READING_WIDTH = 1080;
/** One click of the stepper. */
export const READING_WIDTH_STEP = 40;

/** A trustworthy width from anything the persisted prefs may hold (a hand-edited entry, `null`,
 *  a string, `NaN`): not a finite number → the default; otherwise clamped and snapped to the
 *  stepper's grid, so − / + always land on the values they offer. */
export function sanitizeReadingWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_READING_WIDTH;
  const clamped = Math.min(MAX_READING_WIDTH, Math.max(MIN_READING_WIDTH, value));
  return (
    MIN_READING_WIDTH +
    Math.round((clamped - MIN_READING_WIDTH) / READING_WIDTH_STEP) * READING_WIDTH_STEP
  );
}
