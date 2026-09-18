import { useEffect, useRef, type ReactNode } from "react";
import { FileTree } from "./FileTree";
import { EditorPane } from "./EditorPane";
import { Splitter } from "./Splitter";
import { useFsWatch } from "./useFsWatch";
import { useEditorStore } from "./editorStore";
import { useFileIconStore } from "./fileIcons";
import styles from "./editor.module.css";

/**
 * The right-hand editor panel: [file tree | resizable splitter | editor]. Rooted
 * at the conversation's current working directory (`cwd`), which can move when the
 * agent enters a worktree — `ensureConv` re-roots the tree, and `useFsWatch`
 * re-points the live watch. Kept mounted across conversation switches (props
 * change instead of remounting) so Monaco isn't torn down and rebuilt each time.
 */
/**
 * A host-owned file-tree layout, replacing the editor store's global one. The IDE view
 * passes it so its explorer keeps its own width and visibility: the global flags belong to
 * the conversation view's side panel, where a clicked file mention deliberately COLLAPSES
 * the tree (focus on the file) — a side effect the IDE must not inherit.
 */
export interface TreeLayout {
  width: number;
  collapsed: boolean;
  setWidth: (w: number) => void;
  setCollapsed: (collapsed: boolean) => void;
}

export function EditorPanel({
  convId,
  cwd,
  stacked,
  treeLayout,
  flush = false,
  wrapEditor,
  autoReveal = false,
}: {
  /** The editor slice's key — a conversation's stable id, or an IDE workspace's key. */
  convId: string;
  cwd: string;
  stacked: boolean;
  treeLayout?: TreeLayout;
  /** Drop the conversation-separator border: the panel is the host's root, not a side region. */
  flush?: boolean;
  /** Lay the editor out inside something larger — the IDE view puts its dock under (or
   *  beside) the EDITOR only, leaving the tree full-height as an IDE's explorer is. A
   *  wrapper rather than a sibling slot, so the tree | editor split stays owned here. */
  wrapEditor?: (editor: ReactNode) => ReactNode;
  /** Keep the explorer pointed at the file on screen: whenever the active tab changes,
   *  unfold the folders leading to it and scroll its row into view (an IDE's "auto
   *  reveal"). The IDE view turns it on, so a file opened by an agent, a clicked mention
   *  or a tab switch always shows WHERE that file lives. Off in the conversation view's
   *  side editor, which deliberately hides its tree to focus on the file. */
  autoReveal?: boolean;
}) {
  const globalTreeWidth = useEditorStore((s) => s.treeWidth);
  const setGlobalTreeWidth = useEditorStore((s) => s.setTreeWidth);
  const globalTreeCollapsed = useEditorStore((s) => s.treeCollapsed);
  const setGlobalTreeCollapsed = useEditorStore((s) => s.setTreeCollapsed);
  const treeWidth = treeLayout?.width ?? globalTreeWidth;
  const setTreeWidth = treeLayout?.setWidth ?? setGlobalTreeWidth;
  const treeCollapsed = treeLayout?.collapsed ?? globalTreeCollapsed;
  const setTreeCollapsed = treeLayout?.setCollapsed ?? setGlobalTreeCollapsed;
  const ensureConv = useEditorStore((s) => s.ensureConv);
  const loadIcons = useFileIconStore((s) => s.load);
  const panelRef = useRef<HTMLDivElement>(null);
  // The file on screen, and NOTHING else of the slice: a broad selector here would
  // re-run the reveal on every keystroke in a buffer. Off (constant null) when the
  // host didn't ask for auto-reveal, so the conversation view never subscribes to
  // anything new.
  const activeTab = useEditorStore((s) => (autoReveal ? s.byConv[convId]?.activeTab ?? null : null));

  // Initialise / re-root this conversation's tree at the current cwd.
  useEffect(() => {
    ensureConv(convId, cwd);
  }, [convId, cwd, ensureConv]);

  // Auto-reveal: unfold the explorer down to the active tab and scroll its row into
  // view. Declared AFTER the `ensureConv` effect on purpose — effects run in
  // declaration order within a commit, so the slice already exists at the right root
  // when this fires (a re-root is in the deps via `cwd`, and `treeCollapsed` covers
  // "the tree was just shown", whose rows could not be scrolled while unmounted).
  useEffect(() => {
    if (!autoReveal || treeCollapsed || !activeTab) return;
    void useEditorStore.getState().revealInTree(convId, activeTab);
  }, [autoReveal, convId, cwd, treeCollapsed, activeTab]);

  // Load the Material icon map here (not in FileTree): the panel is always mounted
  // while the editor is shown, so the tabs get real icons even when the file tree
  // is collapsed (FileTree unmounted). Idempotent.
  useEffect(() => loadIcons(), [loadIcons]);

  // Live filesystem watch while the panel is shown.
  useFsWatch(convId, cwd, true);

  // Cmd/Ctrl+W closes the active editor tab. This effect only runs while the
  // editor panel is mounted (open), so the shortcut is scoped to "editor is in
  // use". The native "Close Window" Cmd+W binding is removed (see lib.rs), so this
  // never races the OS — it just closes the tab. No-op when there's no active tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "w" || e.key === "W")) {
        const active = useEditorStore.getState().byConv[convId]?.activeTab;
        if (active) {
          e.preventDefault();
          e.stopPropagation();
          useEditorStore.getState().closeTab(convId, active);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [convId]);

  const onTreeDrag = (clientX: number) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect) setTreeWidth(clientX - rect.left);
  };

  const editor = (
    <EditorPane
      convId={convId}
      treeCollapsed={treeCollapsed}
      onToggleTree={() => setTreeCollapsed(!treeCollapsed)}
    />
  );

  return (
    <div
      ref={panelRef}
      className={
        styles.panel +
        (stacked ? " " + styles.panelStacked : "") +
        (flush ? " " + styles.panelFlush : "")
      }
    >
      {treeCollapsed ? null : (
        <>
          <FileTree
            convId={convId}
            root={cwd}
            width={treeWidth}
            onCollapse={() => setTreeCollapsed(true)}
          />
          <Splitter axis="x" onMove={(x) => onTreeDrag(x)} />
        </>
      )}
      {wrapEditor ? wrapEditor(editor) : editor}
    </div>
  );
}
