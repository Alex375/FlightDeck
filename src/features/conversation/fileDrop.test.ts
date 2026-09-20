import { beforeEach, describe, expect, it } from "vitest";
import { dropPointToCss, dropZoneAttrs, dropZoneOf, useFileDrop } from "./fileDrop";

describe("dropPointToCss", () => {
  it("macOS: the position is already in points — only the interface zoom applies", () => {
    // A Retina screen (dpr 2) must NOT halve it: that would aim at the wrong element.
    expect(dropPointToCss({ x: 400, y: 300 }, { mac: true, zoom: 1, dpr: 2 })).toEqual({ x: 400, y: 300 });
    expect(dropPointToCss({ x: 300, y: 150 }, { mac: true, zoom: 1.5, dpr: 2 })).toEqual({ x: 200, y: 100 });
  });

  it("elsewhere: physical pixels, divided by the device pixel ratio", () => {
    expect(dropPointToCss({ x: 400, y: 300 }, { mac: false, zoom: 1, dpr: 2 })).toEqual({ x: 200, y: 150 });
  });

  it("falls back to 1 on a nonsensical scale rather than producing NaN/Infinity", () => {
    expect(dropPointToCss({ x: 10, y: 20 }, { mac: true, zoom: 0, dpr: 2 })).toEqual({ x: 10, y: 20 });
    expect(dropPointToCss({ x: 10, y: 20 }, { mac: false, zoom: 1, dpr: Number.NaN })).toEqual({ x: 10, y: 20 });
  });
});

describe("dropZoneOf", () => {
  const zone = (convId: string, kind: "pane" | "card") => {
    const el = document.createElement("div");
    for (const [k, v] of Object.entries(dropZoneAttrs(convId, kind))) el.setAttribute(k, v);
    return el;
  };

  it("resolves an element inside a zone to that zone's conversation and kind", () => {
    const card = zone("c1", "card");
    const inner = document.createElement("span");
    card.appendChild(inner);
    const hit = dropZoneOf(inner);
    expect(hit && { convId: hit.convId, kind: hit.kind, el: hit.el === card }).toEqual({
      convId: "c1",
      kind: "card",
      el: true,
    });
  });

  it("picks the innermost zone when zones nest", () => {
    const outer = zone("outer", "pane");
    const inner = zone("inner", "pane");
    const leaf = document.createElement("p");
    outer.appendChild(inner);
    inner.appendChild(leaf);
    expect(dropZoneOf(leaf)?.convId).toBe("inner");
  });

  it("returns null outside every zone, for no element, or for a malformed zone", () => {
    expect(dropZoneOf(document.createElement("div"))).toBeNull();
    expect(dropZoneOf(null)).toBeNull();
    const bad = document.createElement("div");
    bad.setAttribute("data-drop-conv", "c1");
    bad.setAttribute("data-drop-kind", "sidebar");
    expect(dropZoneOf(bad)).toBeNull();
  });
});

describe("useFileDrop", () => {
  beforeEach(() => useFileDrop.setState({ over: null, focusRequest: null }));

  it("keeps the same state object when the hovered zone doesn't change", () => {
    const { setOver } = useFileDrop.getState();
    setOver({ convId: "c1", kind: "pane" });
    const before = useFileDrop.getState();
    setOver({ convId: "c1", kind: "pane" });
    expect(useFileDrop.getState()).toBe(before);
    setOver(null);
    expect(useFileDrop.getState().over).toBeNull();
  });

  it("a focus request is distinct per drop and consumed only by its conversation", () => {
    const s = useFileDrop.getState();
    s.requestFocus("c1");
    const first = useFileDrop.getState().focusRequest;
    s.requestFocus("c1");
    expect(useFileDrop.getState().focusRequest?.seq).not.toBe(first?.seq);
    s.consumeFocus("other");
    expect(useFileDrop.getState().focusRequest?.convId).toBe("c1");
    s.consumeFocus("c1");
    expect(useFileDrop.getState().focusRequest).toBeNull();
  });
});
