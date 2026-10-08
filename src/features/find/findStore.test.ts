import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetFindHostsForTests, registerFindHost, routeFind, useFindStore } from "./findStore";

function el(parent: HTMLElement = document.body, attrs: Record<string, string> = {}): HTMLElement {
  const e = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}

function host(id: string, zone: HTMLElement, opens = true, fallbackRank = 0, log: string[] = []) {
  return registerFindHost({
    id,
    el: () => zone,
    open: () => {
      log.push(id);
      return opens;
    },
    fallbackRank,
  });
}

describe("routeFind", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    __resetFindHostsForTests();
  });
  afterEach(() => __resetFindHostsForTests());

  it("opens the innermost zone holding the focus", () => {
    const log: string[] = [];
    const outer = el();
    const inner = el(outer);
    const input = el(inner);
    host("outer", outer, true, 0, log);
    host("inner", inner, true, 0, log);
    expect(routeFind(input, null)).toBe("opened");
    expect(log).toEqual(["inner"]);
  });

  it("delegates to a zone nested inside one that has nothing to search", () => {
    const log: string[] = [];
    const panel = el();
    const tree = el(panel);
    const preview = el(panel);
    host("panel", panel, false, 0, log);
    host("preview", preview, true, 0, log);
    expect(routeFind(tree, null)).toBe("opened");
    expect(log).toEqual(["panel", "preview"]);
  });

  it("does NOT fall through to another panel when the focused one cannot search", () => {
    const log: string[] = [];
    const image = el();
    const conv = el();
    host("image", image, false, 0, log);
    host("conv", conv, true, 1, log);
    expect(routeFind(image, null)).toBe("unsupported");
    expect(log).toEqual(["image"]);
  });

  it("uses the view's fallback, by rank, when focus is nowhere in particular", () => {
    const log: string[] = [];
    host("conv", el(), true, 1, log);
    host("editor", el(), true, 2, log);
    host("plain", el(), true, 0, log);
    expect(routeFind(document.body, null)).toBe("opened");
    expect(log).toEqual(["editor"]);
  });

  it("stays inside an open modal — and focuses its own search box when it has no zone", () => {
    const log: string[] = [];
    host("behind", el(), true, 1, log);
    const modal = el(document.body, { "aria-modal": "true" });
    const box = document.createElement("input");
    box.setAttribute("data-find-input", "");
    modal.appendChild(box);
    expect(routeFind(document.body, null)).toBe("opened");
    expect(log).toEqual([]);
    expect(document.activeElement).toBe(box);
  });

  it("answers none when nothing on screen is searchable", () => {
    expect(routeFind(document.body, null)).toBe("none");
  });

  it("unregisters cleanly", () => {
    const log: string[] = [];
    const off = host("conv", el(), true, 1, log);
    off();
    expect(routeFind(document.body, null)).toBe("none");
  });
});

describe("find store", () => {
  it("seeds the shared query when a bar opens on a selection, and bumps the nonce", () => {
    const s = useFindStore.getState();
    s.openBar("a", "needle");
    const first = useFindStore.getState().active!.nonce;
    expect(useFindStore.getState().query).toBe("needle");
    s.openBar("a", null);
    expect(useFindStore.getState().active!.nonce).toBe(first + 1);
    expect(useFindStore.getState().query).toBe("needle");
    s.closeBar("other");
    expect(useFindStore.getState().active?.hostId).toBe("a");
    s.closeBar("a");
    expect(useFindStore.getState().active).toBeNull();
  });

  it("queues a find for a surface not on screen yet", () => {
    useFindStore.getState().requestFind("conv:1", "q", { isRegex: true, matchCase: false, wholeWord: false }, { autoFold: true });
    const st = useFindStore.getState();
    expect(st.pending?.surfaceId).toBe("conv:1");
    expect(st.pending?.autoFold).toBe(true);
    expect(st.query).toBe("q");
    expect(st.isRegex).toBe(true);
    st.clearPending();
    expect(useFindStore.getState().pending).toBeNull();
  });
});
