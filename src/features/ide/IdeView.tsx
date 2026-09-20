// The IDE view — a top-level view beside Conversation / Flight Deck / TOSSE that opens a
// FOLDER the way an IDE does: explorer on the left, editor in the middle, and under it a
// dock the size of an IDE's terminal panel that flips between the workspace's shells and
// its agent conversations.
//
// It is an ASSEMBLY, not a second implementation: the explorer + editor are the editor
// feature's `EditorPanel` (keyed by the workspace instead of a conversation), the shells
// are `termManager` terminals, and a docked conversation is the very `ConversationPane`
// the conversation view mounts. What this file owns is the layout around them.
import { useRef, type ReactNode } from "react";
import { Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { repoName, useConversations, useRepos } from "../../store/conversationsStore";
import { EditorPanel, type TreeLayout } from "../editor/EditorPanel";
import { Splitter } from "../editor/Splitter";
import { MIN_CONVERSATION_PANE_PX } from "../conversation/composerLayout";
import { AttentionPips } from "./IdeAttention";
import { DockDropZones } from "./DockDropZones";
import { IdeDock } from "./IdeDock";
import { IdeStatusBar } from "./IdeStatusBar";
import { useDockDrag } from "./useDockDrag";
import { ideBlockedReason, openPickedFolderInIde, openRepoInIde } from "./openInIde";
import {
  editorKeyFor,
  useActiveWorkspace,
  useIdeStore,
  workspaceConversations,
  workspaceLabel,
  type IdeWorkspace,
} from "./ideStore";
import styles from "./ide.module.css";

export function IdeView({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const ws = useActiveWorkspace();
  return (
    <div className={styles.root}>
      <WorkspaceStrip />
      {ws ? <Workspace ws={ws} onOpenConversation={onOpenConversation} /> : <Welcome />}
    </div>
  );
}

// ---- Open folders (the strip under the title bar) -----------------------------------

function WorkspaceStrip() {
  const workspaces = useIdeStore((s) => s.workspaces);
  const activeId = useIdeStore((s) => s.activeId);
  const setActive = useIdeStore((s) => s.setActive);
  const closeWorkspace = useIdeStore((s) => s.closeWorkspace);

  if (workspaces.length === 0) return null;
  return (
    <div className={styles.strip} role="tablist" aria-label="Open folders">
      {workspaces.map((w) => (
        <div
          key={w.id}
          role="tab"
          // Focusable + Enter/Space, like the dock's tabs: a div-based tab is otherwise out
          // of the keyboard's reach (it cannot be a <button> — it holds its close button).
          tabIndex={0}
          aria-selected={w.id === activeId}
          className={styles.wsTab + (w.id === activeId ? " " + styles.wsTabOn : "")}
          onClick={() => setActive(w.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActive(w.id);
            }
          }}
          title={w.path}
        >
          <Ico name="folder" className="sm" />
          <span className={styles.wsTabName}>{workspaceLabel(w.path)}</span>
          <WorkspaceAttention ws={w} />
          <button
            type="button"
            className={styles.tabClose}
            aria-label={`Close ${workspaceLabel(w.path)}`}
            title="Close this folder"
            onClick={(e) => {
              e.stopPropagation();
              void closeWorkspace(w.id);
            }}
          >
            <Ico name="x" className="sm" />
          </button>
        </div>
      ))}
      <OpenFolderMenu
        trigger={
          <button type="button" className={styles.stripAdd} title="Open another folder" aria-label="Open a folder">
            <Ico name="plus" className="sm" />
          </button>
        }
      />
    </div>
  );
}

/** Pips on a folder's tab while one of ITS agents wants the user — so a workspace that is
 *  not on screen is never silently waiting. */
function WorkspaceAttention({ ws }: { ws: IdeWorkspace }) {
  const conversations = useConversations();
  const repos = useRepos();
  const convs = workspaceConversations(ws, conversations, repos);
  return <AttentionPips convIds={convs.map((c) => c.id)} />;
}

/** "Open a folder": the repositories Flight Deck already knows, then the native picker. */
function OpenFolderMenu({ trigger }: { trigger: React.ReactElement }) {
  const repos = useRepos();
  const open = useIdeStore((s) => s.workspaces);
  const openPaths = new Set(open.map((w) => w.path));
  const candidates = repos.filter((r) => !openPaths.has(r.path));
  return (
    <Menu trigger={trigger} portal>
      {candidates.length > 0 ? <MenuLabel>Open a repository</MenuLabel> : null}
      {candidates.map((r) => {
        const blocked = ideBlockedReason(r);
        return (
          <MenuItem
            key={r.id}
            icon={r.machineId ? "globe" : "folder"}
            disabled={!!blocked}
            hint={blocked ? "remote" : undefined}
            onClick={() => openRepoInIde(r)}
          >
            {repoName(r.path)}
          </MenuItem>
        );
      })}
      <MenuItem icon="plus" onClick={() => void openPickedFolderInIde()}>
        Open a folder…
      </MenuItem>
    </Menu>
  );
}

// ---- Nothing open yet ----------------------------------------------------------------

function Welcome() {
  const repos = useRepos();
  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeCard}>
        <div className={styles.welcomeMark}>
          <Ico name="ide" />
        </div>
        <h2 className={styles.welcomeTitle}>Open a folder</h2>
        <p className={styles.welcomeText}>
          Browse and edit its files, run as many terminals as you need, and keep its agent
          conversations one click away — in the panel under the editor.
        </p>
        {repos.length > 0 ? (
          <div className={styles.welcomeList}>
            {repos.map((r) => {
              const blocked = ideBlockedReason(r);
              return (
                <button
                  key={r.id}
                  type="button"
                  className={styles.welcomeRepo}
                  disabled={!!blocked}
                  title={blocked ?? r.path}
                  onClick={() => openRepoInIde(r)}
                >
                  <Ico name={r.machineId ? "globe" : "folder"} className="sm" />
                  <span className={styles.welcomeRepoName}>{repoName(r.path)}</span>
                  <span className={styles.welcomeRepoPath}>
                    <bdi>{blocked ? "Remote — not available" : r.path}</bdi>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <button type="button" className="wf-btn" onClick={() => void openPickedFolderInIde()}>
          <Ico name="plus" className="sm" />
          Open a folder…
        </button>
      </div>
    </div>
  );
}

// ---- One workspace -------------------------------------------------------------------

function Workspace({
  ws,
  onOpenConversation,
}: {
  ws: IdeWorkspace;
  onOpenConversation: (id: string) => void;
}) {
  const treeWidth = useIdeStore((s) => s.treeWidth);
  const treeCollapsed = useIdeStore((s) => s.treeCollapsed);
  const setTreeWidth = useIdeStore((s) => s.setTreeWidth);
  const setTreeCollapsed = useIdeStore((s) => s.setTreeCollapsed);
  // The IDE's OWN explorer layout (see TreeLayout): the conversation view collapses its
  // tree whenever a file mention is clicked, which must not fold this one.
  const treeLayout: TreeLayout = {
    width: treeWidth,
    collapsed: treeCollapsed,
    setWidth: setTreeWidth,
    setCollapsed: setTreeCollapsed,
  };

  return (
    <>
      <div className={styles.main}>
        {/* NOT keyed by workspace: switching folders re-points the panel (props change)
            instead of tearing Monaco down and building it again — the same reason the
            conversation view keeps its panel mounted across conversations. */}
        <EditorPanel
          convId={editorKeyFor(ws.id)}
          cwd={ws.path}
          stacked={false}
          flush
          autoReveal
          treeLayout={treeLayout}
          wrapEditor={(editor) => (
            <EditorAndDock editor={editor} ws={ws} onOpenConversation={onOpenConversation} />
          )}
        />
      </div>
      <IdeStatusBar ws={ws} />
    </>
  );
}

/** The editor with the dock under it (or beside it), split by a draggable divider — and the
 *  level that owns MOVING the dock from one to the other: it renders both the header that
 *  starts the drag and the overlay that shows where the panel would land. */
function EditorAndDock({
  editor,
  ws,
  onOpenConversation,
}: {
  editor: ReactNode;
  ws: IdeWorkspace;
  onOpenConversation: (id: string) => void;
}) {
  const dockOpen = useIdeStore((s) => s.dockOpen);
  const dockPosition = useIdeStore((s) => s.dockPosition);
  const dockFraction = useIdeStore((s) => s.dockFraction);
  const dockMaximized = useIdeStore((s) => s.dockMaximized);
  const setDockFraction = useIdeStore((s) => s.setDockFraction);
  const setDockPosition = useIdeStore((s) => s.setDockPosition);
  const ref = useRef<HTMLDivElement>(null);
  const bottom = dockPosition === "bottom";
  const maximized = dockOpen && dockMaximized;
  // Dragging the panel to the bottom or to the right. This is the level that owns it: the
  // dock's header starts the drag, and the overlay that shows where it would land is a
  // sibling of the editor and dock — both are rendered here. Transient by nature (it lives
  // for the length of one gesture), so it stays in React and out of the persisted store,
  // which only ever hears the RESULT through `setDockPosition`.
  const drag = useDockDrag(ref, setDockPosition);

  const onDrag = (clientX: number, clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    // The dock is the SECOND pane: its share is what lies past the pointer.
    const frac = bottom
      ? 1 - (clientY - rect.top) / rect.height
      : 1 - (clientX - rect.left) / rect.width;
    setDockFraction(frac);
  };

  return (
    <div ref={ref} className={styles.split} style={{ flexDirection: bottom ? "column" : "row" }}>
      <div
        className={styles.editorSlot}
        style={{
          flex: `${dockOpen ? 1 - dockFraction : 1} 1 0`,
          // Hidden, not unmounted, while the dock is maximized: Monaco keeps its models,
          // scroll and undo stack, and comes back as it was.
          display: maximized ? "none" : "flex",
        }}
      >
        {editor}
      </div>
      {dockOpen ? (
        <>
          {maximized ? null : <Splitter axis={bottom ? "y" : "x"} onMove={onDrag} />}
          <div
            className={styles.dockSlot}
            style={{
              flex: `${maximized ? 1 : dockFraction} 1 0`,
              // Beside the editor the dock must still fit a composer — the same floor the
              // conversation view gives its own conversation column — but never MORE than
              // the row has: on a narrow window (or a wide explorer) a fixed 552px floor
              // overflowed the row and pushed the header's buttons off-screen with no way
              // to scroll to them. A cramped composer beats unreachable controls.
              minWidth: bottom ? 0 : `min(${MIN_CONVERSATION_PANE_PX}px, 100%)`,
              minHeight: bottom ? 150 : 0,
            }}
          >
            <IdeDock
              ws={ws}
              onOpenConversation={onOpenConversation}
              onMoveStart={drag.start}
              moving={drag.active}
            />
          </div>
        </>
      ) : null}
      {/* Over both slots, and only while the pointer is down. It measures itself against
          this very container — which keeps its full box even when the editor slot is
          hidden behind a maximized dock. */}
      {drag.active ? <DockDropZones hot={drag.hot} current={dockPosition} /> : null}
    </div>
  );
}
