import { useEffect, useRef, useState } from "react";
import { useDisplay } from "../store/display";
import { motionAllowed } from "./motion";

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
 *  - `settling` → an OPENING transition is running. The body must be clipped while its track
 *    grows, but not once it rests: a permanent `overflow:hidden` quietly cuts anything a row
 *    inside draws outside its own box (a focus ring, a shadow), and re-parents any sticky
 *    descendant to a new scroll container. The closing direction needs no flag — `expanded` is
 *    already false for the whole of it.
 *
 * The FIRST value is applied without animation: a thread reopened with folds already expanded
 * must not replay every opening at once.
 *
 * The duration is NOT a parameter. It has to equal the CSS `--cv-collapse-dur` to work at all
 * (the unmount timer is JS, the transition is CSS), so a caller-supplied value could only ever
 * clip the animation on its last frame or hold a dead node — a knob that cannot safely be
 * turned is not a knob.
 */
export function useCollapseAnim(open: boolean): {
  mounted: boolean;
  expanded: boolean;
  settling: boolean;
} {
  // Subscribed rather than read imperatively: unlike a panel, which is asked only when it is
  // toggled, a disclosure has to answer on every render — turning the preference off must take
  // the animation away from sections that are already on screen, not only from the next one.
  const animate = motionAllowed(useDisplay((s) => s.conversationAnimations));
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [settling, setSettling] = useState(false);
  const first = useRef(true);

  // Adjusted DURING render (never from an effect, which would paint one frame of the stale
  // value): with the animation off the hook is a pass-through, and the internal state has to
  // follow anyway so switching it back on does not resume from a state that is months old.
  if (!animate && (mounted !== open || expanded !== open || settling)) {
    setMounted(open);
    setExpanded(open);
    setSettling(false);
  }

  useEffect(() => {
    if (!animate) return; // nothing to schedule — the render above already settled the state
    if (first.current) {
      first.current = false;
      return; // initial state is already correct — never animate the mount
    }
    if (open) {
      setMounted(true);
      let inner = 0;
      let done = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          setExpanded(true);
          setSettling(true);
          done = window.setTimeout(() => setSettling(false), COLLAPSE_MS);
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        clearTimeout(done);
      };
    }
    setExpanded(false);
    setSettling(false);
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open, animate]);

  if (!animate) return { mounted: open, expanded: open, settling: false };
  return { mounted, expanded, settling };
}
