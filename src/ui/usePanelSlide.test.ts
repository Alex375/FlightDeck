// Behaviour tests for the side-panel slide, rendered through react-dom/client (NOT
// renderToStaticMarkup): zustand's SSR path feeds `useSyncExternalStore` the store's INITIAL
// state, so a server render could never observe the preference flipping. Built with
// createElement so the file stays a `*.test.ts` (the vitest glob), no JSX.
//
// What is locked here is the part a broken animation would hide rather than announce: a panel
// that stays mounted after it was closed, or one that never mounts because the engine has no
// Web Animations API.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDisplay } from "../store/display";
import { neighborFlex, usePanelSlide, useFrozenWhile } from "./usePanelSlide";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDisplay.getState().set({ panelAnimations: true });
  vi.unstubAllGlobals();
});

/** A host that renders `<div data-panel>` for as long as the hook says the panel is mounted. */
function Host({ open }: { open: boolean }): ReactNode {
  const slide = usePanelSlide({
    open,
    axis: "x",
    restStyle: { flex: "0.4 1 0", display: "flex" },
  });
  return slide.mounted
    ? createElement("div", {
        "data-panel": "",
        "data-animating": slide.animating ? "1" : "0",
        ref: slide.slotRef,
        style: slide.slotStyle,
      })
    : null;
}

const panel = () => container.querySelector("[data-panel]");
const render = (open: boolean) => act(() => root.render(createElement(Host, { open })));

describe("usePanelSlide", () => {
  it("mounts on open and unmounts on close when there is no Web Animations API", () => {
    // jsdom has no `Element.prototype.animate`. The panel must still open and close —
    // degrading to the instant behaviour the app had before, never getting stuck mounted.
    expect(typeof Element.prototype.animate).not.toBe("function");
    render(true);
    expect(panel()).not.toBeNull();
    expect(panel()?.getAttribute("data-animating")).toBe("0");
    render(false);
    expect(panel()).toBeNull();
  });

  it("opens and closes instantly when the preference is off", () => {
    useDisplay.getState().set({ panelAnimations: false });
    render(true);
    expect(panel()?.getAttribute("data-animating")).toBe("0");
    render(false);
    expect(panel()).toBeNull();
  });

  it("leaves no animation styling behind at rest, so a splitter drag is untouched", () => {
    render(true);
    // `overflow: hidden` and a pixel `flex-basis` are the sliding state's own styling; either
    // one left behind would freeze the panel at whatever size it opened with, and the
    // splitter would drag a fraction nothing honours. (jsdom drops the `flex` shorthand
    // entirely, so `overflow` is the readable half of that pair here.)
    expect((panel() as HTMLElement).style.overflow).toBe("");
  });
});

// A controllable stand-in for the Web Animations API: jsdom has none, and the states worth
// locking are the ones that only exist WHILE an animation is in flight.
interface FakeAnim {
  cancel: () => void;
  finish: () => void;
  onfinish: (() => void) | null;
  cancelled: boolean;
  finished: boolean;
}
let anims: FakeAnim[] = [];

function installFakeAnimate(): void {
  anims = [];
  (Element.prototype as unknown as { animate: unknown }).animate = function () {
    const a: FakeAnim = {
      onfinish: null,
      cancelled: false,
      finished: false,
      cancel() {
        a.cancelled = true;
      },
      finish() {
        a.finished = true;
        a.onfinish?.();
      },
    };
    anims.push(a);
    return a as unknown as Animation;
  };
}

function removeFakeAnimate(): void {
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  anims = [];
}

// jsdom lays nothing out, so every box measures 0 — and a 0 → 0 travel is (rightly) no
// animation at all. Give the slot a size: its RESTING size when it is being measured, and a
// partway one while it slides (which is what `overflow: hidden` marks).
const RESTING_PX = 420;
const MIDFLIGHT_PX = 200;
function installFakeSizes(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.style.overflow === "hidden" ? MIDFLIGHT_PX : RESTING_PX;
    },
  });
}
function removeFakeSizes(): void {
  delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
}

/** The animation still in flight (not cancelled, not finished), if any. */
const live = () => anims.filter((a) => !a.cancelled && !a.finished);

describe("usePanelSlide, mid-flight", () => {
  beforeEach(() => {
    installFakeAnimate();
    installFakeSizes();
    // ONLY the timer functions the fail-safe uses: faking the whole clock also freezes
    // React's own scheduler, and the state updates the hook schedules from its layout
    // effects would never be flushed.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    removeFakeSizes();
    removeFakeAnimate();
  });

  /** Mount CLOSED, then open: a panel that is already open when the app starts must appear
   *  with the window, not fly in — so the animation only exists on a real toggle. */
  const openFromClosed = () => {
    render(false);
    render(true);
  };

  it("does not animate a panel that is already open on first mount", () => {
    render(true);
    expect(anims).toHaveLength(0);
    expect(panel()?.getAttribute("data-animating")).toBe("0");
  });

  it("stays mounted while closing, and unmounts when the animation lands", () => {
    openFromClosed();
    act(() => live()[0].finish()); // opening animation completes
    expect(panel()?.getAttribute("data-animating")).toBe("0");

    render(false);
    // Still on screen: the panel is folding away, not gone.
    expect(panel()).not.toBeNull();
    expect(panel()?.getAttribute("data-animating")).toBe("1");
    act(() => live()[0].finish());
    expect(panel()).toBeNull();
  });

  it("survives a re-open caught mid-close — including the closing fail-safe", () => {
    // The regression this locks: the closing animation's fail-safe timer fired AFTER the
    // panel had been re-opened and forced it back to "closed", leaving a panel the store
    // says is open with nothing on screen — and no further toggle could bring it back,
    // because `open` never changed again.
    openFromClosed();
    act(() => live()[0].finish());
    render(false); // start closing
    render(true); // re-open before it lands
    expect(panel()).not.toBeNull();
    act(() => live()[live().length - 1].finish());
    expect(panel()).not.toBeNull();
    expect(panel()?.getAttribute("data-animating")).toBe("0");
    // Well past every fail-safe armed along the way.
    act(() => vi.advanceTimersByTime(5000));
    expect(panel()).not.toBeNull();
  });

  it("lands closed when the animation never reports back (a hidden window)", () => {
    openFromClosed();
    act(() => live()[0].finish());
    render(false);
    expect(panel()).not.toBeNull();
    act(() => vi.advanceTimersByTime(5000)); // fail-safe
    expect(panel()).toBeNull();
  });
});

describe("neighborFlex", () => {
  it("hands the region its resting share only while the slot is settled", () => {
    expect(neighborFlex({ mounted: true, animating: false }, 0.7)).toBe("0.7 1 0");
  });

  it("grows to 1 while the slot travels, and while it is not there at all", () => {
    // The slot is sized in pixels mid-flight, so a neighbour still growing by its resting
    // share leaves a blank band where the panel is heading — visible ONLY during the travel.
    expect(neighborFlex({ mounted: true, animating: true }, 0.7)).toBe("1 1 0");
    // …and a single flex child growing by 0.7 fills only 70% of the row, leaving the rest
    // blank, so a closed panel means grow 1 too.
    expect(neighborFlex({ mounted: false, animating: false }, 0.7)).toBe("1 1 0");
  });
});

describe("useFrozenWhile", () => {
  function FrozenHost({ live, value }: { live: boolean; value: string }): ReactNode {
    return createElement("span", { "data-held": "" }, useFrozenWhile(live, value));
  }
  const held = () => container.querySelector("[data-held]")?.textContent;

  it("tracks the value while live, then holds the last one seen", () => {
    act(() => root.render(createElement(FrozenHost, { live: true, value: "editor" })));
    expect(held()).toBe("editor");
    act(() => root.render(createElement(FrozenHost, { live: true, value: "artifact" })));
    expect(held()).toBe("artifact");
    // Closed: the state it is derived from has already gone, but the panel is still leaving.
    act(() => root.render(createElement(FrozenHost, { live: false, value: "" })));
    expect(held()).toBe("artifact");
  });

  it("picks the new value straight back up when it goes live again", () => {
    act(() => root.render(createElement(FrozenHost, { live: true, value: "editor" })));
    act(() => root.render(createElement(FrozenHost, { live: false, value: "" })));
    act(() => root.render(createElement(FrozenHost, { live: true, value: "terminal" })));
    expect(held()).toBe("terminal");
  });
});
