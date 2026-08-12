// The DOM half of the side-panel slide: a small state machine that measures the slot,
// plays the `flex-basis` animation, and hands the layout back untouched when it lands.
// The geometry, timings and styles are pure and live in `panelSlide.ts`.
//
// Phases, and why there are four:
//
//   closed  → nothing is mounted.
//   measure → the panel is mounted with its RESTING style, purely so the browser can
//             tell us how big it is going to be. Never painted: React flushes layout
//             effects (and the state updates they schedule) before the frame, so this
//             phase begins and ends inside one commit.
//   sliding → the animation plays. The slot's BASE style is already the final size, so
//             cancelling mid-flight (a re-toggle, an unmount) lands on the settled
//             layout instead of freezing the panel at an animated width.
//   open    → resting style, no animation, nothing left behind. The splitter drags
//             against exactly the layout it always did.
//
// The panel's content is frozen at its final size for the whole of `sliding` — see
// `panelSlide.ts` for why that is the point of the whole exercise.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useDisplay } from "../store/display";
import {
  frozenPaneStyle,
  restingPaneStyle,
  sizeAlong,
  slideKeyframes,
  slidePlan,
  slidingSlotStyle,
  type SlideAxis,
  type SlideEdge,
  type SlidePlan,
} from "./panelSlide";

type Phase = "closed" | "measure" | "sliding" | "open";

/** Whether the slide may play at all: the user's preference AND the OS "reduce motion"
 *  setting, which always wins (an accessibility choice is not ours to override). Read
 *  imperatively at each toggle, so flipping either takes effect on the very next open
 *  without every panel subscribing to the preference. */
export function panelSlideAllowed(): boolean {
  if (!useDisplay.getState().panelAnimations) return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true; // no matchMedia (test env) — the preference alone decides
  }
}

/** Whether this engine can play the slide at all. */
function hasWebAnimations(): boolean {
  return typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
}

export interface PanelSlideOptions {
  /** Whether the panel SHOULD be showing. The hook keeps it mounted past a `false` for as
   *  long as the closing animation runs. */
  open: boolean;
  axis: SlideAxis;
  /** Which edge the panel is pinned to (default `end`: right / bottom). */
  edge?: SlideEdge;
  /** The slot's style once settled — the parent's own flex/min sizing. Also the style the
   *  slot is measured in, so it must be exactly what the panel rests at. */
  restStyle: CSSProperties;
  /** Set false to switch to instant open/close for this panel while keeping the hook (and
   *  its phase) alive. Used when an ANCESTOR is already animating the same appearance —
   *  a panel sliding inside a sliding panel reads as a stutter, not as depth. Defaults
   *  to true; the user preference and "reduce motion" are checked on top of it. */
  enabled?: boolean;
}

export interface PanelSlide {
  /** Render the panel? True while open AND for the length of a closing animation. */
  mounted: boolean;
  /** An animation is playing. The parent must let the MAIN region take all the space the
   *  slot is not using yet (`flex-grow: 1`): while the slot is sized in px, a neighbour
   *  still growing by `1 - fraction` would leave a blank band where the panel is heading. */
  animating: boolean;
  slotRef: RefObject<HTMLDivElement>;
  /** Style for the slot element (the animated box: splitter + panel). */
  slotStyle: CSSProperties;
  /** Style for the single child inside the slot (the frozen content box). */
  paneStyle: CSSProperties;
}

export function usePanelSlide({
  open,
  axis,
  edge = "end",
  restStyle,
  enabled = true,
}: PanelSlideOptions): PanelSlide {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  // Bumped every time a new plan is posted. It is what tells the player effect "this is a
  // DIFFERENT travel, start over" — the phase alone cannot: a close that interrupts an open
  // stays in `sliding`, and React would not re-run an effect whose deps never changed.
  const [run, setRun] = useState(0);
  const slotRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<Animation | null>(null);
  const planRef = useRef<SlidePlan | null>(null);
  // Where the slot is starting FROM, captured before anything is cancelled or restyled —
  // for a re-toggle mid-flight that is a partly-open panel, not 0 and not full size.
  const fromRef = useRef(0);
  // Read in effects that must not re-run on every change (they own the phase / read intent).
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const openRef = useRef(open);
  openRef.current = open;

  const stop = useCallback(() => {
    animRef.current?.cancel();
    animRef.current = null;
  }, []);

  /** Post a plan and hand it to the player. */
  const play = useCallback((plan: SlidePlan) => {
    planRef.current = plan;
    setRun((n) => n + 1);
    setPhase("sliding");
  }, []);

  // React to the open/closed intent. A layout effect so the whole measure → animate
  // handshake happens before the browser paints: an opening panel's first painted frame
  // is the collapsed slot, never a flash of the full-size panel.
  useLayoutEffect(() => {
    const settled: Phase = open ? "open" : "closed";
    if (phaseRef.current === settled) return;
    // Whatever is on screen right now is where the animation starts — measured BEFORE the
    // running animation is cancelled, since cancelling snaps the slot back to its base
    // style (the previous target) and the start size would be lost.
    const from = sizeAlong(slotRef.current, axis);
    stop();
    // Checked on the PROTOTYPE, not on `slotRef.current`: opening starts with nothing
    // mounted, so an instance check would read `undefined` and silently turn every opening
    // animation off. A missing Web Animations API must degrade, not throw — the panel is the
    // feature, the slide is the flourish.
    if (!enabled || !hasWebAnimations() || !panelSlideAllowed()) {
      setPhase(settled);
      return;
    }
    fromRef.current = from;
    if (open) {
      // The final size isn't knowable until the panel is laid out at its resting style —
      // that's what `measure` is for.
      setPhase("measure");
      return;
    }
    const plan = slidePlan(from, 0);
    if (!plan) {
      setPhase("closed");
      return;
    }
    play(plan);
  }, [open, axis, enabled, stop, play]);

  // measure → sliding: the slot is now laid out exactly as it will rest, so read it.
  useLayoutEffect(() => {
    if (phase !== "measure") return;
    const to = sizeAlong(slotRef.current, axis);
    const plan = slidePlan(fromRef.current, to);
    if (!plan) {
      // Nothing worth playing (a zero-size region, or a panel already at its target):
      // land open rather than animate a pixel.
      setPhase("open");
      return;
    }
    play(plan);
  }, [phase, axis, play]);

  // sliding: play the posted plan. The element's own style already IS the destination, so the
  // animation needs no `fill` — and a cancel from anywhere leaves the settled layout behind.
  //
  // ⚠️ Keyed on `run`, NOT on `open`. Both the animation and its fail-safe belong to ONE
  // travel and are torn down together by this effect's cleanup. Depending on `open` instead
  // re-ran this effect in the same commit that changed the intent — while `phase` was still
  // the OLD `sliding` — so a re-open caught mid-close re-armed the CLOSING plan's fail-safe,
  // which then fired half a second later and shut a panel the user had just reopened. Worse,
  // `open` no longer changed, so nothing could bring it back: the store said open, the screen
  // said gone, and only another full toggle-and-back recovered it.
  useLayoutEffect(() => {
    if (phase !== "sliding") return;
    const el = slotRef.current;
    const plan = planRef.current;
    if (!el || !plan) {
      setPhase(openRef.current ? "open" : "closed");
      return;
    }
    let done = false;
    const land = () => {
      if (done) return;
      done = true;
      animRef.current = null;
      setPhase(plan.to > 0 ? "open" : "closed");
    };
    const anim = el.animate(slideKeyframes(plan), {
      duration: plan.durationMs,
      easing: plan.easing,
    });
    animRef.current = anim;
    anim.onfinish = land;
    // Fail-safe: a timeline that never fires `onfinish` — a hidden window pauses its
    // animations — must not strand a panel half-open, or leave a closed one holding
    // the layout it was told to give back.
    const failsafe = setTimeout(land, plan.durationMs + 400);
    return () => {
      // This travel is over as far as anyone else is concerned: whatever replaces it decides
      // where the panel lands, and a late callback from here must not overrule it.
      done = true;
      clearTimeout(failsafe);
      anim.cancel();
      if (animRef.current === anim) animRef.current = null;
    };
  }, [phase, run]);

  // Never leave a cancelled animation's callback behind us.
  useEffect(() => stop, [stop]);

  const sliding = phase === "sliding";
  const plan = planRef.current;
  // Frozen at the LARGER end of the travel: opening freezes at the final size (so Monaco
  // and xterm lay out once, already correct), closing at the size the panel had when it
  // was told to go (so its content doesn't reflow on the way out).
  const frozenPx = plan ? Math.max(plan.from, plan.to) : 0;
  return {
    mounted: phase !== "closed",
    animating: sliding,
    slotRef,
    // While sliding, the slot is sized in px and clips; the base style is the DESTINATION,
    // so the keyframes have somewhere honest to land.
    slotStyle: sliding
      ? { ...restStyle, ...slidingSlotStyle(axis, plan?.to ?? 0, edge) }
      : restStyle,
    paneStyle: sliding ? frozenPaneStyle(axis, frozenPx) : restingPaneStyle(axis),
  };
}

/**
 * Hold on to the last value seen while `live` — used to keep a closing panel showing what
 * it was showing.
 *
 * A side region's content is derived from the very state that just went false (the editor
 * closed, the artifact was dismissed), so re-rendering it during the exit animation would
 * empty the panel and fold an empty rectangle away. Freezing the inputs keeps the exit
 * showing the panel the user is closing.
 */
export function useFrozenWhile<T>(live: boolean, value: T): T {
  const held = useRef(value);
  if (live) held.current = value;
  return live ? value : held.current;
}
