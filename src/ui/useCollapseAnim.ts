import { useEffect, useRef, useState } from "react";

/** Default open/close duration. Deliberately SHORTER than the app's generic
 *  `--transition-expand` (180ms): a disclosure the user just clicked must feel instant —
 *  they already know what they asked for, the animation only has to keep the eye from losing
 *  its place. Kept a hair above the CSS `--cv-collapse-dur` (110ms) so the unmount lands
 *  after the transition rather than cutting it off on its last frame. */
export const COLLAPSE_MS = 130;

/**
 * Drive an animated disclosure whose body is MOUNTED ONLY WHILE VISIBLE.
 *
 * A plain `{open ? body : null}` cannot animate — the body appears and disappears in one frame.
 * Keeping it permanently mounted would animate fine but costs a full render of every collapsed
 * block (a clean-output thread holds one fold per response), which this app will not pay.
 *
 * So: mount on open, but stay collapsed for one painted frame before expanding (a transition
 * needs a start value the browser has actually rendered), and on close collapse first and
 * unmount only once the transition has run.
 *
 *  - `mounted` → render the body at all.
 *  - `expanded` → the open/closed CSS state (e.g. `grid-template-rows: 1fr` vs `0fr`).
 *
 * The FIRST value is applied without animation: a thread reopened with folds already expanded
 * must not replay every opening at once.
 */
export function useCollapseAnim(
  open: boolean,
  durationMs: number = COLLAPSE_MS,
): { mounted: boolean; expanded: boolean } {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return; // initial state is already correct — never animate the mount
    }
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setExpanded(false);
    const t = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(t);
  }, [open, durationMs]);

  return { mounted, expanded };
}
