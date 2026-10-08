// Painting find hits without touching the DOM: the CSS Custom Highlight API registers Ranges
// under a name, and `::highlight(name)` styles them (see find.css). React keeps owning every
// node; a re-render simply invalidates some ranges, which the next index rebuild replaces.
//
// One DOM find session is open at a time (findStore), so the two names are global.
// Engines without the API (WebKit < 17.2) still get the counter and the scroll to each hit —
// only the paint is missing — so this module degrades to a no-op rather than throwing.

const ALL = "fd-find";
const CURRENT = "fd-find-current";

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): boolean;
}

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const H = (globalThis as { Highlight?: unknown }).Highlight;
  if (!css?.highlights || typeof H !== "function") return null;
  return css.highlights;
}

/** Whether hits can be painted at all in this webview. */
export function highlightsSupported(): boolean {
  return registry() !== null;
}

/** Paint every hit, and the current one on top. `current` may be null (no hit selected). */
export function paintHighlights(all: Range[], current: Range | null): void {
  const reg = registry();
  if (!reg) return;
  const HighlightCtor = (globalThis as unknown as { Highlight: new (...r: Range[]) => { priority: number } })
    .Highlight;
  const allH = new HighlightCtor(...all);
  allH.priority = 0;
  reg.set(ALL, allH);
  if (current) {
    const curH = new HighlightCtor(current);
    curH.priority = 1;
    reg.set(CURRENT, curH);
  } else {
    reg.delete(CURRENT);
  }
}

export function clearHighlights(): void {
  const reg = registry();
  if (!reg) return;
  reg.delete(ALL);
  reg.delete(CURRENT);
}
