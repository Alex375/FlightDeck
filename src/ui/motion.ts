// The app's shared motion policy and easing curves.
//
// Every animated surface asks the SAME two questions — "is this animation switched on?" and
// "does the OS want motion reduced?" — and every one of them should decelerate on the same
// curve, or the app reads as several apps stitched together. Both used to be transcribed per
// feature (the Flight Deck reply modal's zoom, the side panels' slide), which meant the
// policy could only be changed in lockstep by hand: adding a master "reduce all animation"
// switch, or changing what happens when `matchMedia` is unavailable, silently applied to one
// animation and not the other.

/**
 * Whether an animation may play: the caller's own preference AND the OS "reduce motion"
 * setting, which always wins — an accessibility choice is not ours to override.
 *
 * Callers read their preference imperatively (`useDisplay.getState()`) at the moment of the
 * toggle rather than subscribing to it, so flipping the setting takes effect on the very next
 * open without every animated component re-rendering on preference changes.
 */
export function motionAllowed(pref: boolean): boolean {
  return pref && !reduceMotion();
}

/** The OS setting, read through a MediaQueryList kept for the life of the process. `.matches`
 *  stays live on it, so this is a live read and not a cached answer — but it saves re-parsing
 *  the query on every call, and the conversation asks once per rendered disclosure. */
let mql: MediaQueryList | null | undefined;
function reduceMotion(): boolean {
  if (mql === undefined) {
    try {
      mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      mql = null; // no matchMedia (test env) — the preference alone decides
    }
  }
  return mql !== null && mql.matches;
}

/** Decelerating: most of the travel happens early, then it settles. The app's ONE entrance
 *  curve — a panel sliding in and a modal zooming open have to feel like the same hand. */
export const EASE_ENTER = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Accelerating away — the mirror of the entrance. Leaving should feel like it already
 *  happened. */
export const EASE_EXIT = "cubic-bezier(0.4, 0, 0.9, 0.5)";
