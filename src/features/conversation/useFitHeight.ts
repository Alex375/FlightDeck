// Fit-content height for the conversation side panel (`sidePanelFitContent`): the sheet is only
// as tall as what it holds, and grows or shrinks — animated — as sections come and go.
//
// Why script and not CSS: `height: auto` does not transition in WebKit (`interpolate-size` is
// Chromium-only), and the panel's natural height has to be READ to be capped by the room. The
// rules themselves are pure and tested (fitHeightStep); this hook only measures and applies.

import { useLayoutEffect, useRef, type RefObject } from "react";
import { useDisplay } from "../../store/display";
import { EASE_ENTER, motionAllowed } from "../../ui/motion";
import { FIT_GROW_MS, FIT_SHRINK_MS, fitHeightStep, type FitMeasure } from "./sidePanelLayout";

/** The three elements of the panel the hook reads — see {@link useFitHeight}. */
export interface FitRefs {
  panel: RefObject<HTMLElement>;
  body: RefObject<HTMLDivElement>;
  inner: RefObject<HTMLDivElement>;
}

export function useFitRefs(): FitRefs {
  return {
    panel: useRef<HTMLElement>(null),
    body: useRef<HTMLDivElement>(null),
    inner: useRef<HTMLDivElement>(null),
  };
}

/**
 * Size `panel` to its content, capped by `host`. Off (and reset to the stylesheet's height)
 * while `host` is undefined.
 *
 * The panel must be a column of chrome (header, footer) around ONE flexible scroller, `body`,
 * whose single child `inner` carries the sections at their natural height. The natural height
 * is then the chrome plus `inner`: `panel − body + inner`, whatever the panel's current height.
 *
 * ⚠️ Call it from the component that OWNS `host`, never from the panel inside it: React attaches
 * refs child-first, so on mount an ancestor's ref is still null when a descendant's layout
 * effect runs — the hook would silently never start.
 *
 * ⚠️ Imperative on purpose: a ResizeObserver callback runs after layout and BEFORE paint, so
 * writing the height right there means no frame ever shows the panel at a stale size. Going
 * through React state would land a frame later. The panel's own element is never observed —
 * its height is what this writes, and watching it would loop.
 */
export function useFitHeight(host: RefObject<HTMLElement> | undefined, refs: FitRefs): void {
  const { panel: panelRef, body: bodyRef, inner: innerRef } = refs;
  useLayoutEffect(() => {
    const hostEl = host?.current;
    const panel = panelRef.current;
    const body = bodyRef.current;
    const inner = innerRef.current;
    if (!hostEl || !panel || !body || !inner || typeof ResizeObserver === "undefined") return;

    let prev: FitMeasure | null = null;
    let failsafe: ReturnType<typeof setTimeout> | null = null;

    // End of a move: drop the transition (so the next relayout is instant) and let the body
    // scroll again — it is held still while the sheet moves (see `data-fit-moving`).
    const land = () => {
      if (failsafe) clearTimeout(failsafe);
      failsafe = null;
      panel.style.transition = "";
      panel.removeAttribute("data-fit-moving");
    };

    const measure = (): FitMeasure => {
      const cs = getComputedStyle(panel);
      const margins = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      const h = (el: Element) => el.getBoundingClientRect().height;
      return {
        natural: h(panel) - h(body) + h(inner),
        avail: hostEl.clientHeight - margins,
        width: panel.offsetWidth,
      };
    };

    const apply = () => {
      const next = measure();
      // A host not laid out yet (0 tall) is not a reading — the observer fires again once it is.
      if (next.avail <= 0) return;
      const step = fitHeightStep(prev, next);
      prev = next;
      if (!step) return;
      if (step.animate && motionAllowed(useDisplay.getState().panelAnimations)) {
        const ms = step.height > panel.offsetHeight ? FIT_GROW_MS : FIT_SHRINK_MS;
        // Set together with the height, before the next style pass: a transition starts from
        // the value on screen — mid-flight included, so a second change retargets smoothly.
        panel.style.transition = `height ${ms}ms ${EASE_ENTER}`;
        panel.setAttribute("data-fit-moving", "");
        if (failsafe) clearTimeout(failsafe);
        failsafe = setTimeout(land, ms + 120);
      } else {
        land();
      }
      panel.style.height = `${step.height}px`;
    };

    const onEnd = (e: TransitionEvent) => {
      if (e.target === panel && e.propertyName === "height") land();
    };
    panel.addEventListener("transitionend", onEnd);

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(hostEl); // the room
    ro.observe(inner); // the sections
    // The chrome, through the scroller: at a set height, a header or footer that grows, appears
    // or goes (the footer is not rendered while customizing) takes its room from `body`. Watching
    // the chrome's own elements would miss a footer mounted AFTER this effect ran. It also fires
    // on every frame of our own transition — each reading then finds the height unchanged.
    ro.observe(body);

    return () => {
      ro.disconnect();
      panel.removeEventListener("transitionend", onEnd);
      land();
      panel.style.height = "";
    };
  }, [host, panelRef, bodyRef, innerRef]);
}
