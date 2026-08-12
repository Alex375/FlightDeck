// The Git workspace — a JetBrains/PyCharm-style git-history + diff layout that
// takes over the conversation view while Git mode is on.
//
// Two orientations (toggled from the title bar, persisted as `gitOrientation`):
//
//  row (3 columns, default):                       column (stacked):
//   ┌ conv │ diff* │ history ┐                      ┌ conv │ diff* ┐
//   │      │       │ ┌─────┐ │                      ├──────────────┤
//   │      │       │ │tree │ │                      │ tree │ files │ (history strip)
//   │      │       │ ├─────┤ │
//   │      │       │ │files│ │
//
// The diff pane only OPENS when the user clicks a file — until then the
// conversation fills the space. The "Changes" tab swaps the history section to
// working-tree changes + a commit box. All selection is shared via gitViewStore;
// every split is draggable (fractions persisted in the editor store).

import { type MouseEvent as ReactMouseEvent, type RefObject, useRef } from "react";
import { FileDiff, GitBranch, History } from "lucide-react";
import { type Conversation } from "../../store/conversationsStore";
import { type ComposerHandle } from "../conversation/ConductorComposer";
import { ConversationPane } from "../conversation/ConversationPane";
import { Splitter } from "../editor/Splitter";
import { useFrozenWhile, usePanelSlide } from "../../ui/usePanelSlide";
import { clamp, useEditorLayout, useEditorStore } from "../editor/editorStore";
import { useGitAutoRefresh, useGitStatus } from "../../ipc/useGit";
import { useConvGitView, useGitViewStore } from "./gitViewStore";
import { CommitGraphList } from "./CommitGraphList";
import { CommitFileList } from "./CommitFileList";
import { ChangesList } from "./ChangesList";
import { CommitBox } from "./CommitBox";
import { DiffPane } from "./DiffPane";
import styles from "./git.module.css";

export function GitWorkspace({
  conv,
  cwd,
  composerRef,
  onBackgroundClick,
}: {
  conv: Conversation;
  cwd: string;
  composerRef: RefObject<ComposerHandle>;
  onBackgroundClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const convId = conv.id;
  const {
    gitOrientation,
    gitStripFraction,
    gitConvFraction,
    gitStripLeftFraction,
    gitHistFraction,
  } = useEditorLayout();
  const setGitStripFraction = useEditorStore((s) => s.setGitStripFraction);
  const setGitConvFraction = useEditorStore((s) => s.setGitConvFraction);
  const setGitStripLeftFraction = useEditorStore((s) => s.setGitStripLeftFraction);
  const setGitHistFraction = useEditorStore((s) => s.setGitHistFraction);

  const { tab, selectedOid, selectedHistoryFile, selectedChangePath } = useConvGitView(convId);
  const setTab = useGitViewStore((s) => s.setTab);
  const status = useGitStatus(cwd);
  useGitAutoRefresh(cwd);

  const isHistory = tab === "history";
  // The diff opens only once a file is picked — on-demand, like opening a file.
  const diffOpen = isHistory ? !!selectedHistoryFile : !!selectedChangePath;
  const filesOpen = isHistory && !!selectedOid; // commit's files pane (history tab)
  const vertical = gitOrientation === "row"; // 3-column layout

  // The diff pushes the conversation aside as it arrives and folds back into the edge when
  // the selection is cleared, on the same mechanics as the conversation view's side region.
  const diffSlide = usePanelSlide({
    open: diffOpen,
    axis: "x",
    restStyle: {
      flex: `${1 - gitConvFraction} 1 0`,
      minWidth: 0,
      display: "flex",
      flexDirection: "row",
    },
  });
  // Held while the diff folds away: the selection it renders is what just went null, and
  // re-reading it would blink the pane to "Select a file" on its way out.
  const shownSelection = useFrozenWhile(diffOpen, {
    tab,
    selectedOid,
    selectedHistoryFile,
    selectedChangePath,
  });

  const outerRef = useRef<HTMLDivElement>(null);
  const convDiffRef = useRef<HTMLDivElement>(null);
  const topRowRef = useRef<HTMLDivElement>(null);
  const histBodyRef = useRef<HTMLDivElement>(null);

  // ---- drag handlers (each scoped to the right container) -------------------
  const onConvDrag = (clientX: number) => {
    const rect = (vertical ? convDiffRef : topRowRef).current?.getBoundingClientRect();
    if (!rect) return;
    setGitConvFraction(clamp((clientX - rect.left) / rect.width, 0.15, 0.6));
  };
  // History column width (row layout): it's the rightmost column.
  const onHistDrag = (clientX: number) => {
    const rect = outerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setGitHistFraction(clamp(1 - (clientX - rect.left) / rect.width, 0.18, 0.5));
  };
  // Top/strip split (column layout).
  const onStripDrag = (_x: number, clientY: number) => {
    const rect = outerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setGitStripFraction(clamp(1 - (clientY - rect.top) / rect.height, 0.12, 0.6));
  };
  // tree/files split inside the history section (axis depends on orientation).
  const onListDrag = (clientX: number, clientY: number) => {
    const rect = histBodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = vertical
      ? (clientY - rect.top) / rect.height
      : (clientX - rect.left) / rect.width;
    setGitStripLeftFraction(clamp(frac, 0.2, 0.8));
  };

  const branch = status.data?.branch ?? (status.data?.head ? status.data.head.slice(0, 7) : "—");

  const conversation = (
    <ConversationPane
      key={convId}
      session={convId}
      cwd={cwd}
      composerRef={composerRef}
      onBackgroundClick={onBackgroundClick}
    />
  );

  const diff = (
    <div className={styles.wsDiff} style={{ minWidth: 0, minHeight: 0 }}>
      <DiffPane
        cwd={cwd}
        tab={shownSelection.tab}
        selectedOid={shownSelection.selectedOid}
        selectedHistoryFile={shownSelection.selectedHistoryFile}
        selectedChangePath={shownSelection.selectedChangePath}
      />
    </div>
  );

  // The conversation pane + (when a diff is open) its splitter and diff pane — the
  // identical sub-tree shared by the row and column layouts. Hoisted so the splitter
  // geometry (min widths, fraction math, drag wiring) lives in ONE place.
  const convDiff = (
    <>
      <div
        className={styles.wsConv}
        style={{
          // Grow 1 while the diff travels: the slot holds a pixel size of its own then, and
          // the conversation takes whatever it has not claimed yet.
          flex: `${diffSlide.mounted && !diffSlide.animating ? gitConvFraction : 1} 1 0`,
          minWidth: 220,
        }}
      >
        {conversation}
      </div>
      {diffSlide.mounted ? (
        <div ref={diffSlide.slotRef} style={diffSlide.slotStyle}>
          <div style={diffSlide.paneStyle}>
            <Splitter axis="x" onMove={(x) => onConvDrag(x)} />
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>{diff}</div>
          </div>
        </div>
      ) : null}
    </>
  );

  // The git-history section: header (tabs + branch) then the tree/files (history)
  // or changes/commit-box (changes). `vertical` stacks them top/bottom; otherwise
  // side by side. The first pane carries the divider border.
  const gitHistory = (
    <div className={styles.strip}>
      <div className={styles.stripHeader}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${isHistory ? styles.tabActive : ""}`}
            onClick={() => setTab(convId, "history")}
          >
            <History size={13} /> History
          </button>
          <button
            type="button"
            className={`${styles.tab} ${!isHistory ? styles.tabActive : ""}`}
            onClick={() => setTab(convId, "changes")}
          >
            <FileDiff size={13} /> Changes
            {status.data && status.data.files.length > 0 ? (
              <span className={styles.count}>{status.data.files.length}</span>
            ) : null}
          </button>
        </div>
        <span className={styles.spacer} />
        <span className={styles.branchChip} title={status.data?.upstream ?? undefined}>
          <GitBranch size={12} />
          <span className={styles.branchName}>{branch}</span>
        </span>
      </div>
      <div
        ref={histBodyRef}
        className={styles.stripBody}
        style={{ flexDirection: vertical ? "column" : "row" }}
      >
        {isHistory ? (
          <>
            <div
              className={styles.stripPane}
              style={{ flex: `${filesOpen ? gitStripLeftFraction : 1} 1 0` }}
            >
              <CommitGraphList cwd={cwd} convId={convId} />
            </div>
            {filesOpen ? (
              <>
                <Splitter axis={vertical ? "y" : "x"} onMove={onListDrag} />
                <div className={styles.stripPane} style={{ flex: `${1 - gitStripLeftFraction} 1 0` }}>
                  <CommitFileList cwd={cwd} convId={convId} />
                </div>
              </>
            ) : null}
          </>
        ) : (
          <>
            <div
              className={styles.stripPane}
              style={
                vertical
                  ? { flex: "1 1 0", borderBottom: "1px solid var(--wf-line)" }
                  : { flex: "1 1 0", borderRight: "1px solid var(--wf-line)" }
              }
            >
              <ChangesList cwd={cwd} convId={convId} />
            </div>
            <div className={styles.stripPane} style={{ flex: "none" }}>
              <CommitBox cwd={cwd} />
            </div>
          </>
        )}
      </div>
    </div>
  );

  // ---- Row: conv | diff* | history (3 columns) ------------------------------
  if (vertical) {
    return (
      <div ref={outerRef} className={styles.workspace} style={{ flexDirection: "row" }}>
        <div
          ref={convDiffRef}
          className={styles.wsRegion}
          style={{ flex: `${1 - gitHistFraction} 1 0`, flexDirection: "row", minWidth: 0 }}
        >
          {convDiff}
        </div>
        <Splitter axis="x" onMove={(x) => onHistDrag(x)} />
        <div className={styles.wsRegion} style={{ flex: `${gitHistFraction} 1 0`, minWidth: 0 }}>
          {gitHistory}
        </div>
      </div>
    );
  }

  // ---- Column: conv | diff* on top, history strip at the bottom -------------
  return (
    <div ref={outerRef} className={styles.workspace}>
      <div ref={topRowRef} className={styles.wsTop} style={{ flex: `${1 - gitStripFraction} 1 0` }}>
        {convDiff}
      </div>
      <Splitter axis="y" onMove={onStripDrag} />
      <div className={styles.wsRegion} style={{ flex: `${gitStripFraction} 1 0`, minHeight: 0 }}>
        {gitHistory}
      </div>
    </div>
  );
}
