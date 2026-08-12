// Geometry and timing for a side panel that OPENS and CLOSES by pushing the region
// beside it, rather than appearing and vanishing in one frame.
//
// The mechanics, and why they are what they are:
//
//  - The slot the panel lives in animates its `flex-basis` from 0 to the size the
//    layout would give it (and back). That is a real layout animation — it has to
//    be: the point is that the main region is PUSHED, not covered. A transform
//    would slide the panel over the conversation and leave the text underneath
//    snapping to its new width the moment the panel landed.
//
//  - The panel's CONTENT is frozen at its FINAL size for the whole animation, and
//    the slot clips it (`overflow:hidden`, content anchored to the slot's far
//    edge). So the expensive subtrees — Monaco, xterm, the artifact iframe, the PDF
//    canvas — are laid out ONCE, at the size they will keep, and are then revealed
//    by the slot's growing edge. Without this freeze, every one of them would
//    re-layout on every frame of the animation (Monaco runs `automaticLayout`, the
//    terminal a ResizeObserver → `fit()` → a `terminal_resize` IPC call each time),
//    which is exactly the cost this app refuses to pay. It also means the refit
//    that matters has ALREADY happened when the animation ends: the final frame is
//    the settled layout, not something to correct afterwards.
//
//  - The animation runs with no `fill`, over a base style that is ALREADY the final
//    state. So cancelling it at any moment (a re-toggle mid-flight, an unmount) lands
//    on the settled layout instead of stranding the panel at an animated size.
//
// Everything here is pure so the numbers are locked by tests; the DOM orchestration
// lives in {@link usePanelSlide}.

import type { CSSProperties } from "react";

/** Which axis the panel grows along: `x` for a region beside the main one (the usual
 *  right-hand panel), `y` for one stacked below it. */
export type SlideAxis = "x" | "y";

/** Which edge of its slot the panel is pinned to — i.e. which side it emerges FROM.
 *  `end` is the common case (right / bottom); `start` is the editor pushing a terminal
 *  that is already there. */
export type SlideEdge = "start" | "end";

/** How long the panel takes to push its way in. Just under the Flight Deck modal's zoom
 *  (210ms): the panel moves a whole column of layout, so it needs enough frames to read as
 *  travel rather than a jump — but it also sits between the user and the thing they clicked
 *  to see, which is what keeps it this side of 200ms. */
export const SLIDE_IN_MS = 190;
/** …and to fold away. Shorter, like every other exit in the app — leaving should feel
 *  like it already happened. */
export const SLIDE_OUT_MS = 135;

/** Decelerating: most of the travel happens early, then it settles. Same curve the
 *  reply modal opens with, so the two animations feel like one app. */
export const EASE_SLIDE_IN = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Accelerating away — the mirror of the entrance. */
export const EASE_SLIDE_OUT = "cubic-bezier(0.4, 0, 0.9, 0.5)";

/** Below this, a size change is not worth animating (and animating it would just add a
 *  frame of latency to a panel that is already where it belongs). */
const NEGLIGIBLE_PX = 1;

/** A resolved animation: where the slot starts, where it ends, and how it gets there. */
export interface SlidePlan {
  /** Slot size at the first frame, in CSS px. */
  from: number;
  /** Slot size at the last frame, in CSS px. */
  to: number;
  durationMs: number;
  easing: string;
}

/**
 * The plan for a slot travelling `from` → `to`, or `null` when there is nothing to
 * play: a distance under a pixel, or a size we could not measure (a hidden/detached
 * region reports 0, and "0 → 0" is not an animation).
 *
 * Non-finite input answers `null` too, rather than handing WAAPI a `NaNpx` keyframe
 * that it would silently drop — leaving the panel stuck at its start size with no
 * `onfinish` to release it.
 */
export function slidePlan(from: number, to: number): SlidePlan | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const a = Math.max(0, from);
  const b = Math.max(0, to);
  if (Math.abs(a - b) < NEGLIGIBLE_PX) return null;
  const opening = b > a;
  return {
    from: a,
    to: b,
    durationMs: opening ? SLIDE_IN_MS : SLIDE_OUT_MS,
    easing: opening ? EASE_SLIDE_IN : EASE_SLIDE_OUT,
  };
}

/** The keyframes for a plan: the slot's `flex-basis`, which is what actually moves the
 *  layout. Both ends are spelled out (no implicit "from current value") so a plan that
 *  starts mid-flight replays from where the panel really is. */
export function slideKeyframes(plan: SlidePlan): Keyframe[] {
  return [{ flexBasis: `${plan.from}px` }, { flexBasis: `${plan.to}px` }];
}

/** The slot's style WHILE it animates: a fixed basis along the axis (no grow/shrink, so
 *  the keyframes own the size), no minimum (a 280px floor would stop the fold two thirds
 *  of the way), and clipping, since the content inside keeps its full final size. */
export function slidingSlotStyle(
  axis: SlideAxis,
  px: number,
  edge: SlideEdge = "end",
): CSSProperties {
  return {
    flex: `0 0 ${Math.max(0, px)}px`,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    // The content stays pinned to the edge the panel belongs to, so the slot's OTHER edge
    // is what travels — the panel emerges from that side instead of unrolling from the
    // middle of the view.
    display: "flex",
    flexDirection: axis === "x" ? "row" : "column",
    justifyContent: edge === "end" ? "flex-end" : "flex-start",
  };
}

/** The style for the content INSIDE an animating slot: frozen at the size the panel will
 *  settle at, so nothing inside it re-lays-out while the slot travels. */
export function frozenPaneStyle(axis: SlideAxis, px: number): CSSProperties {
  const size = `${Math.max(0, px)}px`;
  return axis === "x"
    ? { flex: `0 0 ${size}`, width: size, height: "100%", display: "flex", minWidth: 0 }
    : { flex: `0 0 ${size}`, height: size, width: "100%", display: "flex", minHeight: 0 };
}

/** The content's style at REST — it simply fills the slot again, which is the same box it
 *  was frozen at, so handing the layout back costs nothing. */
export function restingPaneStyle(axis: SlideAxis): CSSProperties {
  return {
    flex: "1 1 auto",
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: axis === "x" ? "row" : "column",
  };
}

/** The size of a box along the slide axis. Reads the LAYOUT box (`offsetWidth`/`Height`),
 *  never `getBoundingClientRect`: a rect is the VISUAL box, so any transform on an ancestor
 *  (a zoom flourish, a modal's entry animation) would scale the number we then write back
 *  into `flex-basis` as layout pixels — the same trap the reply modal's exit hit. */
export function sizeAlong(el: HTMLElement | null, axis: SlideAxis): number {
  if (!el) return 0;
  return axis === "x" ? el.offsetWidth : el.offsetHeight;
}
