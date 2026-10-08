import { describe, expect, it } from "vitest";
import { buildTextIndex, offsetOf, rangeFor } from "./textIndex";

// jsdom has no layout: every element would read as hidden, so tests pass `() => true`.
const visible = () => true;

function dom(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("buildTextIndex", () => {
  it("joins inline runs so a query can span formatting", () => {
    const root = dom("<p>foo <strong>bar</strong> baz</p>");
    expect(buildTextIndex(root, visible).text).toBe("foo bar baz");
  });

  it("separates blocks so a literal never matches across paragraphs", () => {
    const root = dom("<p>end</p><p>start</p><ul><li>one</li><li>two</li></ul>");
    expect(buildTextIndex(root, visible).text).toBe("end\nstart\none\ntwo");
  });

  it("skips UI chrome, controls and hidden parts", () => {
    const root = dom(
      '<p>keep</p><div data-find-skip=""><span>chrome</span></div><textarea>typed</textarea><p class="h">hidden</p>',
    );
    const idx = buildTextIndex(root, (el) => !el.classList.contains("h"));
    expect(idx.text).toBe("keep");
  });
});

describe("rangeFor / offsetOf", () => {
  it("maps a hit spanning two text nodes back onto the DOM", () => {
    const root = dom("<p>foo <em>bar</em> baz</p>");
    const idx = buildTextIndex(root, visible);
    const start = idx.text.indexOf("o b");
    const r = rangeFor(idx, start, start + 3)!;
    expect(r.toString()).toBe("o b");
    expect(offsetOf(idx, r.startContainer, r.startOffset)).toBe(start);
  });

  it("returns null for an empty span", () => {
    const root = dom("<p>x</p>");
    expect(rangeFor(buildTextIndex(root, visible), 0, 0)).toBeNull();
  });
});
