// The disclosure animation contract. Two failure modes it locks:
//  - opening must render a COLLAPSED frame first, otherwise the body appears at full height
//    and there is nothing for the transition to run from (the plain `{open ? … : null}` bug);
//  - closing must keep the body mounted for the transition, then drop it — permanently
//    mounting every collapsed fold is the cost this hook exists to avoid.
// Plus: the initial value is applied WITHOUT animation, so reopening a thread whose folds are
// already expanded doesn't replay every opening at once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { COLLAPSE_MS, useCollapseAnim } from "./useCollapseAnim";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function Harness({ open }: { open: boolean }) {
  const { mounted, expanded } = useCollapseAnim(open);
  return createElement("div", {
    "data-mounted": mounted ? "1" : "0",
    "data-expanded": expanded ? "1" : "0",
  });
}

const state = () => {
  const el = container.querySelector("[data-mounted]");
  return { mounted: el?.getAttribute("data-mounted") === "1", expanded: el?.getAttribute("data-expanded") === "1" };
};

const render = (open: boolean) =>
  act(() => {
    root.render(createElement(Harness, { open }));
  });

/** Let the two nested rAFs (paint the collapsed state, then expand) run. */
const flushFrames = () => act(() => void vi.advanceTimersByTime(50));

describe("useCollapseAnim", () => {
  it("applies the initial open state without animating it", () => {
    render(true);
    expect(state()).toEqual({ mounted: true, expanded: true });
  });

  it("mounts collapsed, then expands on a later frame", () => {
    render(false);
    expect(state()).toEqual({ mounted: false, expanded: false });

    render(true);
    // Mounted but still collapsed: this is the frame the browser paints as the start value.
    expect(state()).toEqual({ mounted: true, expanded: false });

    flushFrames();
    expect(state()).toEqual({ mounted: true, expanded: true });
  });

  it("collapses first and unmounts only once the transition has run", () => {
    render(true);
    render(false);
    expect(state()).toEqual({ mounted: true, expanded: false });

    act(() => void vi.advanceTimersByTime(COLLAPSE_MS - 20));
    expect(state().mounted).toBe(true);

    act(() => void vi.advanceTimersByTime(40));
    expect(state()).toEqual({ mounted: false, expanded: false });
  });
});
