import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "./usePageVisible";

/** The tick's period: the finest unit a minute-resolution label (« resets in 2h14 »,
 *  « updated 3 min ago ») can show. */
export const MINUTE_MS = 60_000;

/**
 * A minute clock for labels that stay on screen and count down or up — the ones a popover gets
 * away with computing once, at open.
 *
 * It only runs while it has something to move: `enabled` (the caller's own « is there a time to
 * count against at all ») AND the page is visible. Otherwise no timer exists — a hidden window or
 * a caller with nothing to count costs nothing. Mount it in the component that SHOWS the label, so
 * unmounting that component (a folded section) stops it too. Unlike `useNow`, it pauses on
 * `document.hidden`.
 *
 * On resuming after a pause (the page shown again, `enabled` back on) it catches up at once rather
 * than leaving up to a minute of stale label on screen.
 *
 * `onTick` runs on every tick (and on that catch-up), for a caller whose PARENT renders part of
 * the label — e.g. a section header derived from the same clock as the body that owns the timer.
 * Returns the time of the last tick (ms).
 */
export function useMinuteTick(enabled: boolean, onTick?: () => void): number {
  const visible = usePageVisible();
  const on = enabled && visible;
  const [now, setNow] = useState(() => Date.now());
  // Kept in refs so a new callback identity (every render of an inline arrow) never restarts
  // the interval, and the catch-up can tell a real pause from the first mount.
  const cb = useRef(onTick);
  cb.current = onTick;
  const last = useRef(now);

  useEffect(() => {
    if (!on) return;
    const tick = () => {
      const t = Date.now();
      last.current = t;
      setNow(t);
      cb.current?.();
    };
    // Only after a real pause: on a first mount the caller has just rendered with a fresh clock.
    if (Date.now() - last.current >= 1_000) tick();
    const id = setInterval(tick, MINUTE_MS);
    return () => clearInterval(id);
  }, [on]);

  return now;
}
