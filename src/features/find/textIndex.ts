// The DOM half of the in-app find: flatten what a panel SHOWS into one string (so a query can
// span inline formatting — "foo **bar**" is found as "foo bar"), and map a hit in that string
// back to a DOM Range to highlight and scroll to.
//
// Read-only on purpose: React owns these nodes, so we never wrap hits in <mark> (that would
// fight reconciliation and break on the next render). Highlights are painted with the CSS
// Custom Highlight API instead — see `highlights.ts`.

/** The flattened text of a subtree plus the map back to its text nodes. `starts[i]` is where
 *  `nodes[i]` begins in `text`. Between two text nodes of different BLOCKS a "\n" separator is
 *  inserted (mapped to no node), so a literal query never matches across two paragraphs. */
export interface TextIndex {
  text: string;
  nodes: Text[];
  starts: number[];
}

/** Tags that start a new block for the separator rule. A tag list rather than computed styles:
 *  `getComputedStyle` per text node would cost a style resolution each on a long thread. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL", "BUTTON",
]);

/** Never searched: not text the user reads (scripts, styles), or a control's own value. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "SVG", "TEMPLATE"]);

/** Whether an element is rendered. Injectable because jsdom has no layout (every rect is
 *  empty there), so tests pass `() => true`. */
export type VisibilityCheck = (el: Element) => boolean;

export const domVisible: VisibilityCheck = (el) => {
  const anyEl = el as Element & { checkVisibility?: (o?: object) => boolean };
  if (typeof anyEl.checkVisibility === "function") {
    return anyEl.checkVisibility({ visibilityProperty: true });
  }
  return el.getClientRects().length > 0;
};

function blockOf(el: Element, root: Element, cache: Map<Element, Element>): Element {
  const hit = cache.get(el);
  if (hit) return hit;
  let cur: Element | null = el;
  while (cur && cur !== root && !BLOCK_TAGS.has(cur.tagName.toUpperCase())) cur = cur.parentElement;
  const block = cur ?? root;
  cache.set(el, block);
  return block;
}

/**
 * Flatten `root`'s rendered text. Skipped: text under a `[data-find-skip]` element (UI chrome a
 * surface opts out — the find bar itself carries it), under SKIP_TAGS, or not rendered
 * (`isVisible`, cached per parent element — a long thread has far fewer elements than reads).
 */
export function buildTextIndex(root: Element, isVisible: VisibilityCheck = domVisible): TextIndex {
  const nodes: Text[] = [];
  const starts: number[] = [];
  const parts: string[] = [];
  let length = 0;
  const visibleCache = new Map<Element, boolean>();
  const blockCache = new Map<Element, Element>();
  let prevBlock: Element | null = null;

  const accept = (parent: Element): boolean => {
    const known = visibleCache.get(parent);
    if (known !== undefined) return known;
    let ok = !parent.closest("[data-find-skip]");
    if (ok) {
      for (let cur: Element | null = parent; cur && cur !== root.parentElement; cur = cur.parentElement) {
        if (SKIP_TAGS.has(cur.tagName.toUpperCase())) {
          ok = false;
          break;
        }
      }
    }
    if (ok) ok = isVisible(parent);
    visibleCache.set(parent, ok);
    return ok;
  };

  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const textNode = n as Text;
    const value = textNode.data;
    if (!value) continue;
    const parent = textNode.parentElement;
    if (!parent || !accept(parent)) continue;
    const block = blockOf(parent, root, blockCache);
    if (prevBlock && block !== prevBlock) {
      parts.push("\n");
      length += 1;
    }
    prevBlock = block;
    nodes.push(textNode);
    starts.push(length);
    parts.push(value);
    length += value.length;
  }
  return { text: parts.join(""), nodes, starts };
}

/** Index of the text node holding flat offset `pos` — the last node starting at or before it. */
function nodeAt(index: TextIndex, pos: number): number {
  let lo = 0;
  let hi = index.starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.starts[mid] <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * The DOM Range covering flat `[start, end)`, or null when the index has no node there. A
 * boundary falling on a block separator snaps to the edge of the adjacent node — a match
 * never STARTS or ENDS on a separator in practice, but a regex like `a\sb` can span one.
 */
export function rangeFor(index: TextIndex, start: number, end: number): Range | null {
  if (index.nodes.length === 0 || end <= start) return null;
  const doc = index.nodes[0].ownerDocument;
  const si = nodeAt(index, start);
  const ei = nodeAt(index, end - 1);
  const sNode = index.nodes[si];
  const eNode = index.nodes[ei];
  const sOff = Math.min(Math.max(start - index.starts[si], 0), sNode.data.length);
  const eOff = Math.min(Math.max(end - index.starts[ei], 0), eNode.data.length);
  try {
    const r = doc.createRange();
    r.setStart(sNode, sOff);
    r.setEnd(eNode, eOff);
    return r;
  } catch {
    return null; // a node was detached between indexing and now — the next rebuild fixes it
  }
}

/** Flat offset of a DOM boundary point inside an index, or -1 when it is not one of its nodes.
 *  Used to re-anchor the current hit after the panel re-renders. */
export function offsetOf(index: TextIndex, node: Node, offset: number): number {
  const i = index.nodes.indexOf(node as Text);
  return i === -1 ? -1 : index.starts[i] + offset;
}

function isScrollable(el: HTMLElement, axis: "y" | "x"): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") return false;
  return axis === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

/**
 * Scroll every scrollable ancestor of `range` (inner first, up to and including `stopAt`) so
 * the hit sits in view — vertically around the upper third, horizontally just inside. Ranges
 * have no `scrollIntoView`, and the hit can be nested in several scrollers (a Flight Deck lane
 * inside the deck, a code block inside the thread).
 *
 * Rects are VISUAL and `scrollTop` is LAYOUT: under an ancestor transform (the Flight Deck
 * modal's zoom) the delta is divided by the scroller's own scale — see ui/visualScale.ts.
 */
export function scrollRangeIntoView(range: Range, stopAt: HTMLElement | null): void {
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : range.startContainer.parentElement;
  for (let el = startEl; el; el = el.parentElement) {
    const rect = firstRect(range);
    if (!rect) return;
    const box = el.getBoundingClientRect();
    const scaleY = el.offsetHeight > 0 ? box.height / el.offsetHeight || 1 : 1;
    const scaleX = el.offsetWidth > 0 ? box.width / el.offsetWidth || 1 : 1;
    if (isScrollable(el, "y")) {
      const margin = Math.min(48, box.height / 4);
      if (rect.top < box.top + margin || rect.bottom > box.bottom - margin) {
        const want = box.top + box.height / 3;
        el.scrollTop += (rect.top - want) / scaleY;
      }
    }
    if (isScrollable(el, "x")) {
      const r2 = firstRect(range) ?? rect;
      if (r2.left < box.left || r2.right > box.right) {
        el.scrollLeft += (r2.left - box.left - Math.min(40, box.width / 4)) / scaleX;
      }
    }
    if (el === stopAt) return;
  }
}

function firstRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0];
  const r = range.getBoundingClientRect();
  return r.width === 0 && r.height === 0 && r.top === 0 ? null : r;
}
