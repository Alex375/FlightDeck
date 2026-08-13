import { describe, it, expect } from "vitest";
import {
  EASE_SLIDE_IN,
  EASE_SLIDE_OUT,
  SLIDE_IN_MS,
  SLIDE_OUT_MS,
  frozenPaneStyle,
  restingPaneStyle,
  sizeAlong,
  slideKeyframes,
  slidePlan,
  slidingSlotStyle,
} from "./panelSlide";

describe("slidePlan", () => {
  it("opens with the entrance timing and closes with the (shorter) exit one", () => {
    expect(slidePlan(0, 420)).toEqual({
      from: 0,
      to: 420,
      durationMs: SLIDE_IN_MS,
      easing: EASE_SLIDE_IN,
    });
    expect(slidePlan(420, 0)).toEqual({
      from: 420,
      to: 0,
      durationMs: SLIDE_OUT_MS,
      easing: EASE_SLIDE_OUT,
    });
    expect(SLIDE_OUT_MS).toBeLessThan(SLIDE_IN_MS);
  });

  it("refuses to play a sub-pixel move — a panel already where it belongs", () => {
    expect(slidePlan(0, 0)).toBeNull();
    expect(slidePlan(420, 420.4)).toBeNull();
  });

  it("refuses a size it could not measure, rather than handing WAAPI a NaN keyframe", () => {
    // A NaNpx keyframe is dropped silently: the panel would stick at its start size with
    // no `onfinish` to release it, so there must be no plan at all.
    expect(slidePlan(Number.NaN, 300)).toBeNull();
    expect(slidePlan(0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("clamps a negative measurement to zero instead of animating past the edge", () => {
    expect(slidePlan(-30, 200)?.from).toBe(0);
  });

  it("resumes from wherever the panel IS — a re-open caught mid-close", () => {
    // 140px of a 420px panel still showing: it must travel from there, not from 0.
    const plan = slidePlan(140, 420);
    expect(plan?.from).toBe(140);
    expect(plan?.durationMs).toBe(SLIDE_IN_MS);
  });
});

describe("slideKeyframes", () => {
  it("spells out BOTH ends, so an interrupted travel replays from where it really is", () => {
    expect(slideKeyframes({ from: 140, to: 420, durationMs: 1, easing: "linear" })).toEqual([
      { flexBasis: "140px" },
      { flexBasis: "420px" },
    ]);
  });
});

describe("slidingSlotStyle", () => {
  it("holds the size itself (no grow/shrink, no minimum) and clips its content", () => {
    const st = slidingSlotStyle("x", 420);
    // grow/shrink 0: the keyframes own the size. A `min-width` floor would stop a closing
    // panel two thirds of the way down.
    expect(st.flex).toBe("0 0 420px");
    expect(st.minWidth).toBe(0);
    expect(st.minHeight).toBe(0);
    expect(st.overflow).toBe("hidden");
  });

  it("pins the panel to the edge it comes from", () => {
    expect(slidingSlotStyle("x", 420).justifyContent).toBe("flex-end"); // right-hand panel
    expect(slidingSlotStyle("y", 300).justifyContent).toBe("flex-end"); // panel below
    expect(slidingSlotStyle("x", 420, "start").justifyContent).toBe("flex-start"); // editor
  });

  it("lays out along the slide axis", () => {
    expect(slidingSlotStyle("x", 420).flexDirection).toBe("row");
    expect(slidingSlotStyle("y", 300).flexDirection).toBe("column");
  });

  it("never writes a negative basis", () => {
    expect(slidingSlotStyle("x", -5).flex).toBe("0 0 0px");
  });
});

describe("frozenPaneStyle", () => {
  it("freezes the content at its FINAL size along the axis, filling the other one", () => {
    // This is the whole point: Monaco, xterm, the artifact iframe and the PDF canvas lay
    // out ONCE, at the size they will keep, instead of on every frame of the travel.
    const x = frozenPaneStyle("x", 420);
    expect(x.width).toBe("420px");
    expect(x.height).toBe("100%");
    expect(x.flex).toBe("0 0 420px");

    const y = frozenPaneStyle("y", 300);
    expect(y.height).toBe("300px");
    expect(y.width).toBe("100%");
  });

  it("freezes the flow DIRECTION too, matching the resting style", () => {
    // Omitting it does not mean "unchanged": `display:flex` with no direction is `row`, so a
    // y-axis pane laid its children out side by side for the whole slide and snapped to a
    // column on landing — the terminal's horizontal divider rendered as a vertical bar and
    // xterm was measured at the wrong box, i.e. exactly the re-layout the freeze prevents.
    expect(frozenPaneStyle("x", 420).flexDirection).toBe(restingPaneStyle("x").flexDirection);
    expect(frozenPaneStyle("y", 300).flexDirection).toBe(restingPaneStyle("y").flexDirection);
    expect(frozenPaneStyle("y", 300).flexDirection).toBe("column");
  });
});

describe("restingPaneStyle", () => {
  it("hands the box back to the layout once the travel is over", () => {
    const st = restingPaneStyle("x");
    expect(st.flex).toBe("1 1 auto");
    expect(st.minWidth).toBe(0);
    expect(st.flexDirection).toBe("row");
  });
});

describe("sizeAlong", () => {
  it("reads the LAYOUT box, not the visual one — an ancestor transform must not scale it", () => {
    const el = {
      offsetWidth: 420,
      offsetHeight: 300,
      // If this were ever read, a zoomed/animated ancestor would feed scaled pixels back
      // into `flex-basis` as if they were layout pixels.
      getBoundingClientRect: () => ({ width: 210, height: 150 }) as DOMRect,
    } as unknown as HTMLElement;
    expect(sizeAlong(el, "x")).toBe(420);
    expect(sizeAlong(el, "y")).toBe(300);
  });

  it("answers 0 for a panel that is not mounted", () => {
    expect(sizeAlong(null, "x")).toBe(0);
  });
});
