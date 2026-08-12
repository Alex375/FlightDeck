import { lazy, Suspense, useRef } from "react";
import { EditorPanel } from "../editor/EditorPanel";
import { Splitter } from "../editor/Splitter";
import { clamp, useEditorStore } from "../editor/editorStore";
import { usePanelSlide } from "../../ui/usePanelSlide";

// Lazy: xterm.js + its WebGL/fit addons stay out of the startup bundle (mirrors
// Monaco) — fetched only when the integrated terminal is first opened.
const TerminalView = lazy(() => import("../terminal/TerminalView"));

/**
 * The right-hand side region: the editor and/or the integrated terminal. The
 * region itself is placed by `sideBySide` (true = to the right of the conversation,
 * false = below it) — that outer split is handled by MainArea. Here we lay out the
 * two panes WITHIN the region, splitting along the axis perpendicular to the
 * region's placement so the result reads naturally:
 *
 *  - Region on the right (sideBySide): a tall column → editor on top, terminal at
 *    the BOTTOM (a horizontal divider). "Terminal at the bottom right."
 *  - Region below (stacked): a wide strip → editor on the left, terminal on the
 *    RIGHT (a vertical divider). "Terminal on the right."
 *
 * With only one pane open it fills the region (terminal alone = the whole right
 * side). `terminalFraction` (draggable) sizes the terminal when both are open, so
 * the terminal resizes in both height and width depending on the layout.
 *
 * Which panes are open comes in as PROPS rather than being read from the layout
 * store: while the whole region folds away, MainArea holds these at their last
 * values so the exit animation shows the panel being closed instead of an empty box
 * (see useFrozenWhile).
 */
export function SidePanel({
  convId,
  cwd,
  sideBySide,
  editorOpen,
  terminalOpen,
}: {
  convId: string;
  cwd: string;
  sideBySide: boolean;
  editorOpen: boolean;
  terminalOpen: boolean;
}) {
  const terminalFraction = useEditorStore((s) => s.terminalFraction);
  const setTerminalFraction = useEditorStore((s) => s.setTerminalFraction);
  const ref = useRef<HTMLDivElement>(null);
  const both = editorOpen && terminalOpen;

  // Inner direction is perpendicular to the region's placement: region-on-right
  // (sideBySide) stacks vertically (column); region-below stacks horizontally (row).
  const innerColumn = sideBySide;
  // Both panes carry the same conversation-separator border as the editor would
  // (left when the region is on the right, top when it's below).
  const stacked = !sideBySide;
  const innerAxis = innerColumn ? "y" : "x";

  const onInnerDrag = (clientX: number, clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    // Terminal fraction = the space past the pointer (terminal is the 2nd pane).
    const frac = innerColumn
      ? 1 - (clientY - rect.top) / rect.height
      : 1 - (clientX - rect.left) / rect.width;
    setTerminalFraction(clamp(frac, 0.15, 0.85));
  };

  // Each pane slides in and out against the OTHER one, on the same mechanics the whole
  // region uses — but ONLY while its neighbour is there to be pushed. A pane arriving on
  // its own IS the region arriving, which MainArea already animates; playing both would
  // slide a panel inside a sliding panel. Hence `enabled` on the neighbour's state.
  //
  // The editor is pinned to the START edge (left / top) and the terminal to the END, so
  // each emerges from its own side rather than unrolling out of the middle.
  const editorSlide = usePanelSlide({
    open: editorOpen,
    axis: innerAxis,
    edge: "start",
    enabled: terminalOpen,
    restStyle: {
      flex: `${both ? 1 - terminalFraction : 1} 1 0`,
      minWidth: 0,
      minHeight: 0,
      display: "flex",
      flexDirection: innerColumn ? "column" : "row",
    },
  });
  const termSlide = usePanelSlide({
    open: terminalOpen,
    axis: innerAxis,
    enabled: editorOpen,
    restStyle: {
      flex: `${both ? terminalFraction : 1} 1 0`,
      minWidth: 0,
      minHeight: 0,
      display: "flex",
      flexDirection: innerColumn ? "column" : "row",
    },
  });
  // While one pane travels on a pixel size of its own, the other takes everything it has
  // not claimed yet (grow 1) — the same reason the conversation does in MainArea.
  const sliding = editorSlide.animating || termSlide.animating;

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: innerColumn ? "column" : "row",
      }}
    >
      {editorSlide.mounted ? (
        <div
          ref={editorSlide.slotRef}
          style={
            sliding && !editorSlide.animating
              ? { ...editorSlide.slotStyle, flex: "1 1 0" }
              : editorSlide.slotStyle
          }
        >
          <div style={editorSlide.paneStyle}>
            <EditorPanel convId={convId} cwd={cwd} stacked={stacked} />
          </div>
        </div>
      ) : null}
      {termSlide.mounted ? (
        <div
          ref={termSlide.slotRef}
          style={
            sliding && !termSlide.animating
              ? { ...termSlide.slotStyle, flex: "1 1 0" }
              : termSlide.slotStyle
          }
        >
          <div style={termSlide.paneStyle}>
            {/* The divider exists only while both panes do, and it rides INSIDE the
                terminal's slot: a terminal folding away takes the divider with it instead
                of leaving an orphaned 6px line behind, and the measured slot size is the
                one the layout really settles at. */}
            {editorSlide.mounted ? <Splitter axis={innerAxis} onMove={onInnerDrag} /> : null}
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
              <Suspense fallback={<div style={{ flex: 1, background: "var(--wf-bg)" }} />}>
                <TerminalView convId={convId} cwd={cwd} stacked={stacked} />
              </Suspense>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
