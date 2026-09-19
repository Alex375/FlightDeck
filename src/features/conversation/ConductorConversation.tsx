import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  loadConversationHistory,
  type Conversation,
} from "../../store/conversationsStore";
import { useSessionState } from "../../store/conversationStore";
import { effectiveCwd } from "../git/worktree";
import { Splitter } from "../editor/Splitter";
import {
  clamp,
  useConvPanelShown,
  useEditorLayout,
  useEditorStore,
  useSideRegionOpen,
} from "../editor/editorStore";
import { MIN_CONVERSATION_PANE_PX } from "./composerLayout";
import { SidePanel } from "./SidePanel";
import { ArtifactViewer } from "./ArtifactViewer";
import { TaskDetail } from "../tosse/TosseView";
import { ConversationPane } from "./ConversationPane";
import { type ComposerHandle } from "./ConductorComposer";
import { ConductorSidebar } from "./ConductorSidebar";
import { ConversationSidePanel } from "./ConversationSidePanel";
import { SIDE_PANEL_PX, SIDE_REGION_MIN_PX, sidePanelDocks } from "./sidePanelLayout";
import { useDisplay } from "../../store/display";
import { neighborFlex, useFrozenWhile, usePanelSlide } from "../../ui/usePanelSlide";

// Lazy: the Git workspace pulls in Monaco's diff editor + ribbon overlay — its
// own chunk, off the startup bundle, fetched only when Git mode is opened.
const GitWorkspace = lazy(() =>
  import("../git/GitWorkspace").then((m) => ({ default: m.GitWorkspace })),
);

// Interactive elements whose clicks must NOT be hijacked to focus the composer
// (buttons, links, other fields, expandable tool-card headers via role=button…).
const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="option"], [role="tab"], [contenteditable="true"]';

/**
 * Conversation view: the sidebar (always present, so a folder can be opened even
 * with nothing selected) plus the thread/composer for the active conversation.
 *
 * Everything is keyed by the conversation's STABLE id. Lazy policy: selecting a
 * conversation loads its transcript history (no `claude` process spawned) and
 * shows it read-only; the live session starts only when the user sends a message
 * (the composer spawns it). `active` is null when nothing is selected.
 */
export function ConductorConversation({ active }: { active: Conversation | null }) {
  const activeId = active?.id ?? null;
  const composerRef = useRef<ComposerHandle>(null);

  // On selection, replay the on-disk transcript into the message store (idempotent,
  // at most once per conversation). Covers both the boot-active conversation and
  // any later selection — without spawning anything.
  useEffect(() => {
    if (activeId) void loadConversationHistory(activeId);
  }, [activeId]);

  // Click anywhere in the conversation column → focus the composer, so the whole
  // view is "click to type". Don't steal an active selection (copying a message)
  // and don't hijack clicks landing on interactive elements.
  const focusComposerOnClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!window.getSelection()?.isCollapsed) return;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    composerRef.current?.focus();
  };

  return (
    <>
      <ConductorSidebar />
      {active ? (
        <ConversationArea
          conv={active}
          composerRef={composerRef}
          onBackgroundClick={focusComposerOnClick}
        />
      ) : (
        <div
          className="wf-col"
          style={{ flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center" }}
        >
          <div
            style={{
              color: "var(--wf-tx-lo)",
              fontSize: 13,
              lineHeight: 1.6,
              textAlign: "center",
              maxWidth: 320,
              padding: 24,
            }}
          >
            No conversations. Open a folder with ＋ in the sidebar to start one.
          </div>
        </div>
      )}
    </>
  );
}

/** Live layout width of `ref`'s element, or null before it is first measured. Reads the
 *  LAYOUT box (`offsetWidth`), like the panel slide does, so a transform on an ancestor never
 *  skews the number compared against the px floors. */
function useLayoutWidth(ref: RefObject<HTMLElement>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * Everything right of the conversations sidebar: the main area (conversation + its
 * editor/terminal/Git region) and, at the far right, the conversation side panel.
 *
 * The panel DOCKS in its own column when the conversation (and the side region, when open)
 * keeps its minimum width beside it. When it cannot, it never crushes them: it STEPS ASIDE
 * (the conversation shows its one-line summary instead) — the conversation and the editor or
 * terminal the user just opened are the working surfaces. Asking for the panel explicitly
 * while there is no room (toggle, ⌘I, the summary line) brings it back FLOATING over the
 * right edge. The docking test measures THIS wrapper, whose width does not depend on whether
 * the panel docks, so the decision cannot oscillate.
 */
function ConversationArea({
  conv,
  composerRef,
  onBackgroundClick,
}: {
  conv: Conversation;
  composerRef: RefObject<ComposerHandle>;
  onBackgroundClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const sidePanelPref = useDisplay((s) => s.conversationSidePanel);
  const panelShown = useConvPanelShown();
  const sideRegionOpen = useSideRegionOpen(conv.id);
  const areaRef = useRef<HTMLDivElement>(null);
  const areaWidth = useLayoutWidth(areaRef);
  // Unmeasured (first commit) → assume it docks: the common case, and a wrong guess is
  // corrected before paint by the layout effect above.
  const docks = areaWidth === null || sidePanelDocks(areaWidth, sideRegionOpen);
  const want = sidePanelPref && panelShown;

  // Step aside whenever the room runs out — re-decided each time the room or the side region
  // changes, so opening the terminal on a narrow window hides the panel rather than covering
  // the terminal. An explicit open clears the flag in between (→ floating) and sticks until
  // the next such change. Layout effect: the decision lands before paint, no one-frame float.
  useLayoutEffect(() => {
    useEditorStore.getState().setConvPanelYielded(!docks);
  }, [docks, sideRegionOpen]);

  // Switching between docked and floating is a relayout, not the user opening or closing
  // the panel: that transition must not play the slide (it would fold the docked copy away
  // while the floating one is already on screen). Read from the previous render.
  const docksRef = useRef(docks);
  const docksChanged = docksRef.current !== docks;
  docksRef.current = docks;
  const slide = usePanelSlide({
    open: want && docks,
    axis: "x",
    enabled: !docksChanged,
    restStyle: { flex: `0 0 ${SIDE_PANEL_PX}px`, minWidth: 0, minHeight: 0, display: "flex" },
  });

  return (
    <div
      ref={areaRef}
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", position: "relative" }}
    >
      <div style={{ flex: neighborFlex(slide, 1), minWidth: 0, minHeight: 0, display: "flex" }}>
        <MainArea conv={conv} composerRef={composerRef} onBackgroundClick={onBackgroundClick} />
      </div>
      {slide.mounted ? (
        <div ref={slide.slotRef} style={slide.slotStyle}>
          <div style={slide.paneStyle}>
            <ConversationSidePanel conv={conv} />
          </div>
        </div>
      ) : null}
      {want && !docks ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: SIDE_PANEL_PX,
            zIndex: 20,
            display: "flex",
            boxShadow: "-18px 0 36px -20px #000",
          }}
        >
          <ConversationSidePanel conv={conv} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The area to the right of the conversations sidebar: the conversation column
 * and, when the editor and/or the integrated terminal is open, a resizable side
 * region beside it (side-by-side) or below it (stacked). The split is dragged via
 * the divider; its fraction and orientation are remembered globally (editor
 * store). The side region is rooted at the conversation's LIVE working directory
 * (follows EnterWorktree/ExitWorktree).
 */
function MainArea({
  conv,
  composerRef,
  onBackgroundClick,
}: {
  conv: Conversation;
  composerRef: RefObject<ComposerHandle>;
  onBackgroundClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const { open, terminalOpen, gitOpen, orientation, editorFraction } = useEditorLayout();
  const setEditorFraction = useEditorStore((s) => s.setEditorFraction);
  const artifactView = useEditorStore((s) => s.artifactView);
  const closeArtifact = useEditorStore((s) => s.closeArtifact);
  const tosseTaskView = useEditorStore((s) => s.tosseTaskView);
  const closeTosseTask = useEditorStore((s) => s.closeTosseTask);
  const liveState = useSessionState(conv.id);
  const cwd = effectiveCwd(conv, liveState);
  const areaRef = useRef<HTMLDivElement>(null);
  const sideBySide = orientation === "row";
  // The artifact viewer takes over the side region (for THIS conversation) while set; the side
  // region otherwise shows when the editor or terminal is open.
  const showArtifact = !!artifactView && artifactView.convId === conv.id;
  // The TOSSE task panel shares the artifact viewer's contract: it takes over the side
  // region for THIS conversation, and holds that region open on its own.
  const showTosseTask = !!tosseTaskView && tosseTaskView.convId === conv.id;
  const sideOpen = open || terminalOpen || showArtifact || showTosseTask;

  // The side region slides in and out rather than appearing in one frame: the slot below
  // (splitter + panel) animates its size while the conversation gives way over the same
  // fraction of a second. `animating` is why the conversation's grow factor is read from it
  // — see PanelSlide.animating.
  const slide = usePanelSlide({
    open: sideOpen,
    axis: sideBySide ? "x" : "y",
    restStyle: {
      flex: `${editorFraction} 1 0`,
      minWidth: sideBySide ? SIDE_REGION_MIN_PX : 0,
      minHeight: sideBySide ? 0 : 160,
      display: "flex",
      flexDirection: sideBySide ? "row" : "column",
    },
  });

  // What the side region shows, HELD for the length of a closing animation: every input
  // below comes from the state that just went false, so re-reading it while the panel folds
  // away would empty the panel first and fold an empty box (see useFrozenWhile).
  const shown = useFrozenWhile(sideOpen, {
    kind: showTosseTask ? "tosse" : showArtifact ? "artifact" : "panes",
    taskId: tosseTaskView?.taskId ?? null,
    artifact: artifactView,
    editorOpen: open,
    terminalOpen,
  });

  // Git mode takes over the whole area with its own 2x2 workspace (conversation
  // minimized top-left, diff top-right, history + files strip at the bottom),
  // independent of the editor/terminal region.
  if (gitOpen) {
    return (
      <Suspense fallback={<div style={{ flex: 1, background: "var(--wf-bg)" }} />}>
        <GitWorkspace
          conv={conv}
          cwd={cwd}
          composerRef={composerRef}
          onBackgroundClick={onBackgroundClick}
        />
      </Suspense>
    );
  }

  const onSplitDrag = (clientX: number, clientY: number) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Fraction the SIDE REGION occupies = remaining space past the pointer.
    const frac = sideBySide
      ? 1 - (clientX - rect.left) / rect.width
      : 1 - (clientY - rect.top) / rect.height;
    setEditorFraction(clamp(frac, 0.15, 0.85));
  };

  return (
    <div
      ref={areaRef}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: sideBySide ? "row" : "column",
      }}
    >
      <div
        style={{
          // Grow-ratio split (not a rigid basis) so both panes honour their
          // min-size: the conversation never gets crushed below a usable width.
          // Closed or travelling, the grow factor must be 1 — see neighborFlex,
          // which owns that rule for every side panel in the app.
          flex: neighborFlex(slide, 1 - editorFraction),
          // 552 = the composer's 500px floor + the 52px its card leaves on either side
          // (see MIN_COMPOSER_PX). Below it the composer bar can no longer hold the
          // slots the budget promised, so the splitter stops here instead.
          minWidth: sideBySide ? MIN_CONVERSATION_PANE_PX : 0,
          minHeight: sideBySide ? 0 : 200,
          display: "flex",
        }}
      >
        {/* Keyed by the STABLE id so the pane (thread + composer + its
            stick-to-bottom state) remounts per conversation. */}
        <ConversationPane
          key={conv.id}
          session={conv.id}
          cwd={cwd}
          composerRef={composerRef}
          onBackgroundClick={onBackgroundClick}
          panelHost
        />
      </div>
      {slide.mounted ? (
        // The animated slot holds the splitter AND the panel, so the divider travels with
        // the panel instead of blinking into place 6px early.
        <div ref={slide.slotRef} style={slide.slotStyle}>
          <div style={slide.paneStyle}>
            <Splitter axis={sideBySide ? "x" : "y"} onMove={onSplitDrag} />
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
              {shown.kind === "tosse" && shown.taskId ? (
                // Keyed by task id so switching tasks remounts the panel (it replays its
                // section cascade), as the board's own panel does.
                <TaskDetail
                  key={shown.taskId}
                  taskId={shown.taskId}
                  onClose={closeTosseTask}
                  embedded
                />
              ) : shown.kind === "artifact" && shown.artifact ? (
                <ArtifactViewer view={shown.artifact} onClose={closeArtifact} />
              ) : (
                <SidePanel
                  convId={conv.id}
                  cwd={cwd}
                  sideBySide={sideBySide}
                  editorOpen={shown.editorOpen}
                  terminalOpen={shown.terminalOpen}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
