// PyCharm/JetBrains-style side-by-side diff: Monaco's diff editor (which already
// does the two-tone line + intra-line highlighting and synced scroll) PLUS a
// custom SVG overlay that draws the "ribbons" — the filled trapezoids in the
// central gutter connecting each changed block on the left (old) to its block on
// the right (new). Monaco 0.55.1 does NOT draw these natively, so we paint them
// from `getLineChanges()` + per-line pixel offsets, re-rendered on scroll/layout.
//
// HEAVY (Monaco) → imported LAZILY (DiffSlot's React.lazy), its own chunk off the
// startup bundle. Worker env + theme come from the shared `monacoEnv` module.

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { setupMonaco } from "../editor/monacoEnv";
import { languageForPath } from "../editor/language";

// Ribbon tints by change kind, aligned with the app palette (green add / red
// delete / blue modify) — translucent fill + a slightly stronger edge.
const RIBBON: Record<"add" | "del" | "mod", string> = {
  add: "#5fb98c",
  del: "#e0727c",
  mod: "#7aa2e3",
};

type Kind = "add" | "del" | "mod";
const SVG_NS = "http://www.w3.org/2000/svg";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface Props {
  path: string;
  oldText: string;
  newText: string;
  /** For texts that are EXCERPTS of the real files (a patch's hunks, see the editor's
   *  diff Preview): the label each side's gutter shows per displayed line (index =
   *  line − 1) — its line number in the real file, "" for a line that is not part of it.
   *  Omitted (whole files, the Git panel) → plain 1..N. Pass a stable (memoized) value. */
  lineLabels?: { original: string[]; modified: string[] };
  /** Lines (1-based, per side) painted as a band across the editor — the headers between
   *  two excerpts — with `className` (a global class: Monaco renders outside React). */
  bands?: { original: number[]; modified: number[]; className: string };
}

export default function RibbonDiff({ path, oldText, newText, lineLabels, bands }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalModel = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedModel = useRef<monaco.editor.ITextModel | null>(null);

  // Create the diff editor + wire the ribbon overlay exactly once.
  useEffect(() => {
    setupMonaco();
    const ed = monaco.editor.createDiffEditor(hostRef.current!, {
      theme: "tosse-dark",
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      // Keep two panels even when narrow, else the ribbon coordinates collapse.
      useInlineViewWhenSpaceIsLimited: false,
      // Overview ruler ON: colored marks on the right scrollbar show where the
      // changes are when scrolling fast.
      renderOverviewRuler: true,
      renderMarginRevertIcon: false,
      diffAlgorithm: "advanced",
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      scrollBeyondLastLine: false,
      scrollbar: { useShadows: false },
    });
    editorRef.current = ed;

    const original = ed.getOriginalEditor();
    const modified = ed.getModifiedEditor();
    const svg = svgRef.current!;
    let raf = 0;

    const draw = () => {
      raf = 0;
      const wrap = wrapRef.current;
      const changes = ed.getLineChanges();
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!wrap || !changes) return;

      const wrapRect = wrap.getBoundingClientRect();
      const oNode = original.getDomNode();
      const mNode = modified.getDomNode();
      if (!oNode || !mNode) return;
      const oRect = oNode.getBoundingClientRect();
      const mRect = mNode.getBoundingClientRect();

      svg.setAttribute("width", String(wrapRect.width));
      svg.setAttribute("height", String(wrapRect.height));

      // Span the ribbon across a WIDE band — from the right edge of the left
      // editor's code to the start of the right editor's TEXT (past its line
      // numbers) — so the connector reads like JetBrains' central gutter rather
      // than Monaco's thin sash. The translucent fill over the right gutter is
      // intentional (matches the researched recipe).
      const oScrollbar = original.getLayoutInfo().verticalScrollbarWidth;
      const xLeft = oRect.right - oScrollbar - wrapRect.left;
      const xRight = mRect.left - wrapRect.left + modified.getLayoutInfo().contentLeft;
      const midX = (xLeft + xRight) / 2;

      // Each side's content origin + viewport bounds in wrapper coordinates.
      const oOriginY = oRect.top - wrapRect.top;
      const mOriginY = mRect.top - wrapRect.top;
      const oViewTop = oOriginY;
      const oViewBot = oOriginY + oRect.height;
      const mViewTop = mOriginY;
      const mViewBot = mOriginY + mRect.height;

      const oScroll = original.getScrollTop();
      const mScroll = modified.getScrollTop();
      // Pixel top of a line, content space, scroll subtracted. `includeViewZones`
      // folds in the alignment spacers — crucial so sub-ribbons track the lines
      // actually highlighted (see the per-charChange loop below).
      const topO = (line: number) => original.getTopForLineNumber(line, true) - oScroll;
      const topM = (line: number) => modified.getTopForLineNumber(line, true) - mScroll;

      // Paint one trapezoid connecting [oTop..oBot] on the left to [mTop..mBot] on
      // the right (content-space y's), clamped to each viewport. Fill only — a
      // block scrolled so one side clamps to a viewport edge collapses to a
      // zero-area sliver (invisible), whereas a stroke would ride the edge.
      const paint = (oTop: number, oBot: number, mTop: number, mBot: number, kind: Kind) => {
        const oy0 = clamp(oOriginY + oTop, oViewTop, oViewBot);
        const oy1 = clamp(oOriginY + oBot, oViewTop, oViewBot);
        const my0 = clamp(mOriginY + mTop, mViewTop, mViewBot);
        const my1 = clamp(mOriginY + mBot, mViewTop, mViewBot);
        if (oy0 === oy1 && my0 === my1) return; // fully scrolled out of both
        const d =
          `M ${xLeft} ${oy0} ` +
          `C ${midX} ${oy0}, ${midX} ${my0}, ${xRight} ${my0} ` +
          `L ${xRight} ${my1} ` +
          `C ${midX} ${my1}, ${midX} ${oy1}, ${xLeft} ${oy1} Z`;
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        p.setAttribute("fill", RIBBON[kind]);
        p.setAttribute("fill-opacity", "0.22");
        svg.appendChild(p);
      };

      for (const c of changes) {
        const hasOld = c.originalEndLineNumber > 0;
        const hasNew = c.modifiedEndLineNumber > 0;
        const kind: Kind = !hasOld ? "add" : !hasNew ? "del" : "mod";

        // A modified hunk carries INNER (char) changes. In side-by-side mode
        // Monaco inserts alignment spacers at line boundaries WITHIN the hunk, so a
        // single trapezoid over the outer bounds skews mid-hunk (the bug: "3→3
        // lines with modifications and deletions"). Draw one sub-ribbon per inner
        // change instead — each end uses `getTopForLineNumber(..,true)` so it
        // tracks the spacer-shifted line it actually highlights.
        if (kind === "mod" && c.charChanges && c.charChanges.length > 0) {
          for (const cc of c.charChanges) {
            // An inner change's range is EMPTY on a side when text was only
            // inserted/deleted there (Monaco's Range.isEmpty: start === end on
            // line AND column). Collapse that side to a tip rather than painting a
            // phantom one-line band on the unchanged side. The exclusive bottom
            // drops the +1 when the range ends at column 1 (already the first
            // unchanged line), else +1 turns the inclusive end into exclusive.
            const oHas =
              cc.originalEndLineNumber > cc.originalStartLineNumber ||
              cc.originalEndColumn > cc.originalStartColumn;
            const mHas =
              cc.modifiedEndLineNumber > cc.modifiedStartLineNumber ||
              cc.modifiedEndColumn > cc.modifiedStartColumn;
            const oExcl =
              cc.originalEndColumn === 1 ? cc.originalEndLineNumber : cc.originalEndLineNumber + 1;
            const mExcl =
              cc.modifiedEndColumn === 1 ? cc.modifiedEndLineNumber : cc.modifiedEndLineNumber + 1;
            const oTop = topO(cc.originalStartLineNumber);
            const oBot = oHas ? topO(oExcl) : oTop;
            const mTop = topM(cc.modifiedStartLineNumber);
            const mBot = mHas ? topM(mExcl) : mTop;
            paint(oTop, oBot, mTop, mBot, "mod");
          }
          continue;
        }

        // Pure add/del (or a mod without inner detail): one trapezoid over the
        // whole hunk; the absent side collapses to a tip at the insertion site.
        const oStart = hasOld ? c.originalStartLineNumber : c.originalStartLineNumber + 1;
        const oTop = topO(oStart);
        const oBot = hasOld ? topO(c.originalEndLineNumber + 1) : oTop;
        const mStart = hasNew ? c.modifiedStartLineNumber : c.modifiedStartLineNumber + 1;
        const mTop = topM(mStart);
        const mBot = hasNew ? topM(c.modifiedEndLineNumber + 1) : mTop;
        paint(oTop, oBot, mTop, mBot, kind);
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const disposables = [
      original.onDidScrollChange((e) => {
        if (e.scrollTopChanged) schedule();
      }),
      modified.onDidScrollChange((e) => {
        if (e.scrollTopChanged) schedule();
      }),
      original.onDidLayoutChange(schedule),
      modified.onDidLayoutChange(schedule),
      // Symmetric on both editors: a view-zone/alignment-spacer height settling on
      // the ORIGINAL side (no scroll/layout event) would otherwise leave the left
      // ribbon endpoints stale.
      original.onDidContentSizeChange(schedule),
      modified.onDidContentSizeChange(schedule),
      ed.onDidUpdateDiff(schedule),
    ];
    const ro = new ResizeObserver(schedule);
    if (wrapRef.current) ro.observe(wrapRef.current);
    schedule();

    return () => {
      disposables.forEach((d) => d.dispose());
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      ed.dispose();
      originalModel.current?.dispose();
      modifiedModel.current?.dispose();
      editorRef.current = null;
      originalModel.current = null;
      modifiedModel.current = null;
    };
  }, []);

  // (Re)build the models whenever the file or its contents change. Recreating
  // keeps the language correct and forces a fresh diff (→ onDidUpdateDiff → draw).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const language = languageForPath(path);
    const original = monaco.editor.createModel(oldText, language);
    const modified = monaco.editor.createModel(newText, language);
    // Swap THEN dispose: disposing a model the diff editor still holds makes Monaco report
    // "TextModel got disposed before DiffEditorWidget model got reset" on every change.
    const previous = [originalModel.current, modifiedModel.current];
    ed.setModel({ original, modified });
    previous.forEach((m) => m?.dispose());
    originalModel.current = original;
    modifiedModel.current = modified;

    // Gutter labels and bands go on each side's own editor (they differ per side). Set on
    // every model change, never left over from the previous texts.
    const sides = [
      [ed.getOriginalEditor(), lineLabels?.original, bands?.original, original],
      [ed.getModifiedEditor(), lineLabels?.modified, bands?.modified, modified],
    ] as const;
    const collections = sides.map(([editor, labels, bandLines, model]) => {
      editor.updateOptions({ lineNumbers: labels ? (n: number) => labels[n - 1] ?? "" : "on" });
      return editor.createDecorationsCollection(
        (bands ? (bandLines ?? []) : []).map((line) => ({
          range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
          options: { isWholeLine: true, className: bands!.className, inlineClassName: bands!.className },
        })),
      );
    });
    return () => collections.forEach((c) => c.clear());
  }, [path, oldText, newText, lineLabels, bands]);

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      <svg
        ref={svgRef}
        style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 4 }}
        aria-hidden="true"
      />
    </div>
  );
}
