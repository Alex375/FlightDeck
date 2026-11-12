import { describe, expect, it } from "vitest";
import { scopeSvgValue } from "./ServiceMark";
import { SERVICE_MARK_ART, type SvgNode } from "./serviceMarkArt";

/** Every node of a tree, depth-first. */
function walk(nodes: SvgNode[], out: SvgNode[] = []): SvgNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n[2]) walk(n[2], out);
  }
  return out;
}

/** The SVG vocabulary the art may use: drawing and paint-server elements only. */
const SVG_TAGS = new Set([
  "path", "circle", "rect", "ellipse", "polygon", "g", "defs", "use",
  "linearGradient", "radialGradient", "stop", "mask", "clipPath",
  "filter", "feFlood", "feBlend", "feGaussianBlur",
]);

describe("scopeSvgValue", () => {
  it("renames an id and repoints references to it", () => {
    expect(scopeSvgValue("id", "g1", "x")).toBe("g1-x");
    expect(scopeSvgValue("fill", "url(#g1)", "x")).toBe("url(#g1-x)");
    expect(scopeSvgValue("mask", "url(#m)", "x")).toBe("url(#m-x)");
    expect(scopeSvgValue("href", "#g1", "x")).toBe("#g1-x");
    expect(scopeSvgValue("xlinkHref", "#g1", "x")).toBe("#g1-x");
  });

  it("leaves ordinary values alone", () => {
    expect(scopeSvgValue("fill", "#4285F4", "x")).toBe("#4285F4");
    expect(scopeSvgValue("d", "M0 0h1", "x")).toBe("M0 0h1");
    expect(scopeSvgValue("href", "https://example.com", "x")).toBe("https://example.com");
  });
});

describe("service mark art", () => {
  it("uses only drawing elements, with no event handler or external reference", () => {
    for (const [name, art] of Object.entries(SERVICE_MARK_ART)) {
      expect(art.viewBox, name).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
      for (const [tag, props] of walk(art.nodes)) {
        expect(SVG_TAGS.has(tag), `${name}: <${tag}>`).toBe(true);
        for (const [k, v] of Object.entries(props)) {
          expect(k, `${name}: ${k}`).not.toMatch(/^on/i);
          if (typeof v === "string") expect(v, `${name}: ${k}`).not.toMatch(/javascript:|https?:/i);
        }
      }
    }
  });

  it("references only ids defined in the same mark", () => {
    for (const [name, art] of Object.entries(SERVICE_MARK_ART)) {
      const nodes = walk(art.nodes);
      const ids = new Set(nodes.map(([, p]) => p.id).filter((v): v is string => typeof v === "string"));
      for (const [, props] of nodes) {
        for (const [k, v] of Object.entries(props)) {
          if (typeof v !== "string") continue;
          const refs = [...v.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
          if ((k === "href" || k === "xlinkHref") && v.startsWith("#")) refs.push(v.slice(1));
          for (const r of refs) expect(ids.has(r), `${name} → #${r}`).toBe(true);
        }
      }
    }
  });
});
