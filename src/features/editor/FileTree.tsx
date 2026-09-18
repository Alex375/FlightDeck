import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { commands } from "../../ipc/client";
import type { FsEntry } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import { useDisplay } from "../../store/display";
import { Ico } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { baseName, dirName } from "./language";
import { useEditorStore, type EditTarget } from "./editorStore";
import { isHiddenName } from "./hiddenEntries";
import { FileContextMenu, type CtxMenuEntry } from "./FileContextMenu";
import { fileIconUrl, folderIconUrl, useFileIcons, type IconMap } from "./fileIcons";
import styles from "./editor.module.css";

/** Indentation per tree depth, px. */
const INDENT = 12;

/** Real Material icon for a tree entry, with a generic-glyph fallback while the
 *  icon map is still loading (or for a name it doesn't cover). */
function EntryIcon({ entry, isOpen, iconMap }: { entry: FsEntry; isOpen: boolean; iconMap: IconMap | null }) {
  const url = iconMap
    ? entry.is_dir
      ? folderIconUrl(iconMap, entry.path, isOpen)
      : fileIconUrl(iconMap, entry.path)
    : null;
  if (url) return <img src={url} className={styles.entryIcon} alt="" draggable={false} />;
  return (
    <span className={styles.rowIcon + " " + (entry.is_dir ? styles.dirIcon : "")}>
      <Ico name={entry.is_dir ? "folder" : "file"} className="sm" />
    </span>
  );
}

/** A generic icon for an in-progress "new file / new folder" inline input (no
 *  FsEntry exists yet). */
function NewEntryIcon({ kind }: { kind: "newFile" | "newDir" }) {
  return (
    <span className={styles.rowIcon + (kind === "newDir" ? " " + styles.dirIcon : "")}>
      <Ico name={kind === "newDir" ? "folder" : "file"} className="sm" />
    </span>
  );
}

/** The inline name editor shown in the tree for a rename or a new file/folder.
 *  Enter commits, Escape cancels, blur commits; a `settled` latch makes the
 *  blur-after-commit/cancel a no-op so the op never fires twice. */
function EditRow({
  depth,
  icon,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  icon: ReactNode;
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the stem (everything before the extension) like VS Code, so typing
    // replaces the name but keeps the extension; a new/extensionless entry selects all.
    const dot = initial.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial]);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  return (
    <div className={styles.row + " " + styles.rowEdit} style={{ paddingLeft: depth * INDENT + 8 }}>
      <span className={styles.twisty} />
      {icon}
      <input
        ref={inputRef}
        className={styles.editInput}
        value={value}
        spellCheck={false}
        // Let the webview's native copy/paste menu open in the input instead of the
        // tree's custom file menu.
        onContextMenu={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

/**
 * The file tree for a conversation, rooted at its working directory. Lazily
 * expands one level per click (`toggleDir` reads exactly that directory), so even
 * a huge repo only reads what the user opens. Selects just the tree-relevant
 * slice (dirs / expanded / errors / activeTab / editing / treeReveal) with a
 * shallow comparison, so typing in an open buffer — which mutates a sibling part of
 * the store — never re-renders it. Right-click opens a VS Code-style context menu
 * (new / rename / delete / cut / copy / paste / reveal).
 *
 * Two display behaviours ride on the rows: a one-shot scroll request from
 * `revealInTree` (found by `data-path`), and the dimming of hidden dot-names, which
 * stay listed and clickable but styled as things you did not mean to open.
 */
export function FileTree({
  convId,
  root,
  width,
  onCollapse,
}: {
  convId: string;
  root: string;
  width: number;
  /** Hide the tree — the panel decides which layout (the global one or a host's own) flips. */
  onCollapse: () => void;
}) {
  const { dirs, expanded, loadingDirs, dirErrors, activeTab, editing, treeReveal } = useEditorStore(
    useShallow((s) => {
      const c = s.byConv[convId];
      return {
        dirs: c?.dirs ?? EMPTY_DIRS,
        expanded: c?.expanded ?? EMPTY_FLAGS,
        loadingDirs: c?.loadingDirs ?? EMPTY_FLAGS,
        dirErrors: c?.dirErrors ?? EMPTY_ERRORS,
        activeTab: c?.activeTab ?? null,
        editing: c?.editing ?? null,
        treeReveal: c?.treeReveal ?? null,
      };
    }),
  );
  const toggleDir = useEditorStore((s) => s.toggleDir);
  const clearTreeReveal = useEditorStore((s) => s.clearTreeReveal);
  // Dot-names (.git, .DS_Store…) are dimmed unless the user turned that off.
  const dimHidden = useDisplay((s) => s.explorerDimHidden);
  const openFile = useEditorStore((s) => s.openFile);
  const startCreate = useEditorStore((s) => s.startCreate);
  const startRename = useEditorStore((s) => s.startRename);
  const cancelEdit = useEditorStore((s) => s.cancelEdit);
  const commitEdit = useEditorStore((s) => s.commitEdit);
  const deletePath = useEditorStore((s) => s.deletePath);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const pasteInto = useEditorStore((s) => s.pasteInto);
  const clipboard = useEditorStore((s) => s.clipboard);

  // Material file/folder icons (the map is loaded by EditorPanel, which stays
  // mounted while the editor is shown — even when this tree is collapsed).
  const iconMap = useFileIcons();

  // Open context menu (cursor anchor + the entry it targets, null = root) and the
  // pending delete confirmation.
  const [menu, setMenu] = useState<{ x: number; y: number; target: FsEntry | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The rendered rows, scoping the reveal's `data-path` lookup below (the scroll
  // itself walks up to `.tree`, which is the scrolling element).
  const bodyRef = useRef<HTMLDivElement>(null);

  // Paths cut to the clipboard — dimmed in the tree until pasted (or replaced).
  const cutSet = useMemo(
    () => (clipboard?.mode === "cut" ? new Set(clipboard.paths) : EMPTY_SET),
    [clipboard],
  );

  // Load + expand the root the first time it's shown (or after a root move). The
  // `!dirErrors[root]` guard is essential: without it, a failing read (deleted
  // cwd, permissions) would re-fire this effect forever (read → fail → re-render
  // → read …). A click on the header retries.
  useEffect(() => {
    if (dirs[root] === undefined && !loadingDirs[root] && !dirErrors[root]) {
      void toggleDir(convId, root);
    }
  }, [convId, root, dirs, loadingDirs, dirErrors, toggleDir]);

  // Consume a one-shot "scroll this row into view" request (`revealInTree` records
  // it only once every ancestor listing is in, so the row is rendered in the very
  // commit this effect runs after). `block: "nearest"` scrolls the minimum needed —
  // a row already on screen doesn't move — and nothing here takes focus: the user
  // may be typing in the editor while the explorer catches up.
  useEffect(() => {
    if (!treeReveal) return;
    const row = bodyRef.current?.querySelector<HTMLElement>(
      // A path is a CSS string here, so only `"` and `\` need escaping.
      `[data-path="${treeReveal.path.replace(/["\\]/g, "\\$&")}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
    // Consumed either way: a row we could not find (the file is no longer in the
    // parent's listing) must not leave a request pending for every later render to
    // retry. The reveal is ambient, so a miss is silent BY DESIGN — a real failure
    // to read a directory is already surfaced by `dirErrors` on the way down.
    clearTreeReveal(convId);
  }, [treeReveal, convId, clearTreeReveal]);

  const rootEntries = dirs[root];
  const rootIcon = iconMap ? folderIconUrl(iconMap, root, true) : null;
  const editingNewAtRoot = editing && editing.kind !== "rename" && editing.parentPath === root;

  function openMenu(e: React.MouseEvent, target: FsEntry | null) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }

  /** Copy text to the system clipboard, surfacing a failure (the unified channel). */
  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      useAppErrors.getState().pushError("Could not copy to clipboard.", String(err));
    }
  }

  /** Reveal a path in the OS file manager, surfacing a failure. The `.catch` is
   *  essential: the generated binding RE-THROWS a genuine transport Error, which a
   *  bare `void promise` would drop as an unhandled rejection (zero-silent-error). */
  function reveal(path: string) {
    void commands
      .revealInFinder(path)
      .then((res) => {
        if (res.status !== "ok")
          useAppErrors.getState().pushError(`"Reveal in Finder" failed: ${baseName(path)}`, res.error);
      })
      .catch((e) =>
        useAppErrors.getState().pushError(`"Reveal in Finder" failed: ${baseName(path)}`, String(e)),
      );
  }

  /** A path relative to the tree root (for "Copy Relative Path"). */
  function relPath(p: string): string {
    if (p === root) return baseName(p);
    return p.startsWith(root + "/") ? p.slice(root.length + 1) : baseName(p);
  }

  /** The context-menu entries for the right-clicked target (null = root / empty). */
  function buildEntries(target: FsEntry | null): CtxMenuEntry[] {
    const hasClip = !!clipboard && clipboard.paths.length > 0;
    if (!target) {
      return [
        { label: "New file", icon: "file", onClick: () => startCreate(convId, root, "newFile") },
        { label: "New folder", icon: "folder", onClick: () => startCreate(convId, root, "newDir") },
        "sep",
        { label: "Paste", icon: "clipboard", disabled: !hasClip, onClick: () => void pasteInto(convId, root) },
        "sep",
        { label: "Copy path", icon: "link", onClick: () => void copyText(root) },
        { label: "Reveal in Finder", icon: "external", onClick: () => reveal(root) },
      ];
    }
    // New entries land inside a folder, or beside a file (in its parent dir).
    const dir = target.is_dir ? target.path : dirName(target.path);
    return [
      { label: "New file", icon: "file", onClick: () => startCreate(convId, dir, "newFile") },
      { label: "New folder", icon: "folder", onClick: () => startCreate(convId, dir, "newDir") },
      "sep",
      { label: "Cut", icon: "scissors", onClick: () => setClipboard([target.path], "cut") },
      { label: "Copy", icon: "copy", onClick: () => setClipboard([target.path], "copy") },
      { label: "Paste", icon: "clipboard", disabled: !hasClip, onClick: () => void pasteInto(convId, dir) },
      "sep",
      { label: "Copy path", icon: "link", onClick: () => void copyText(target.path) },
      { label: "Copy relative path", icon: "link", onClick: () => void copyText(relPath(target.path)) },
      "sep",
      { label: "Rename", icon: "pencil", onClick: () => startRename(convId, target.path) },
      { label: "Delete", icon: "trash", danger: true, onClick: () => setConfirmDelete(target) },
      "sep",
      { label: "Reveal in Finder", icon: "external", onClick: () => reveal(target.path) },
    ];
  }

  return (
    <div className={styles.tree} style={{ width, flex: `0 0 ${width}px` }}>
      <div className={styles.treeHead} title={root} onContextMenu={(e) => openMenu(e, null)}>
        {rootIcon ? (
          <img src={rootIcon} className={styles.entryIcon} alt="" draggable={false} />
        ) : (
          <Ico name="folder" className="sm" />
        )}
        <span className={styles.rowName} style={{ flex: 1, minWidth: 0 }}>
          {baseName(root)}
        </span>
        <button
          type="button"
          className={styles.treeClose}
          onClick={onCollapse}
          title="Hide file tree"
          aria-label="Hide file tree"
        >
          <Ico name="x" className="sm" />
        </button>
      </div>
      <div ref={bodyRef} className={styles.treeBody} onContextMenu={(e) => openMenu(e, null)}>
        {dirErrors[root] ? (
          <div className={styles.treeError} title={dirErrors[root]}>
            <Ico name="alert" className="sm" />
            Unable to read this folder.
            <button type="button" className={styles.treeRetry} onClick={() => void toggleDir(convId, root)}>
              Retry
            </button>
          </div>
        ) : rootEntries === undefined ? (
          <div className={styles.treeLoading}>Loading…</div>
        ) : (
          <>
            {editingNewAtRoot ? (
              <EditRow
                depth={0}
                icon={<NewEntryIcon kind={editing.kind === "newDir" ? "newDir" : "newFile"} />}
                initial=""
                onCommit={(name) => void commitEdit(convId, name)}
                onCancel={() => cancelEdit(convId)}
              />
            ) : null}
            {rootEntries.length === 0 && !editingNewAtRoot ? (
              <div className={styles.treeEmpty}>Empty folder</div>
            ) : (
              rootEntries.map((e) => (
                <TreeNode
                  key={e.path}
                  entry={e}
                  depth={0}
                  dirs={dirs}
                  expanded={expanded}
                  loadingDirs={loadingDirs}
                  dirErrors={dirErrors}
                  activeTab={activeTab}
                  editing={editing}
                  cutSet={cutSet}
                  dimHidden={dimHidden}
                  iconMap={iconMap}
                  onToggleDir={(p) => void toggleDir(convId, p)}
                  onOpenFile={(p) => void openFile(convId, p, { preview: true })}
                  onPinFile={(p) => void openFile(convId, p, { preview: false })}
                  onContextMenu={openMenu}
                  onCommitEdit={(name) => void commitEdit(convId, name)}
                  onCancelEdit={() => cancelEdit(convId)}
                />
              ))
            )}
          </>
        )}
      </div>

      {menu ? (
        <FileContextMenu x={menu.x} y={menu.y} entries={buildEntries(menu.target)} onClose={() => setMenu(null)} />
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        danger
        busy={deleting}
        title={confirmDelete ? `Delete "${confirmDelete.name}"?` : ""}
        confirmLabel="Move to Trash"
        onCancel={() => {
          if (!deleting) setConfirmDelete(null);
        }}
        onConfirm={() => {
          if (!confirmDelete) return;
          setDeleting(true);
          void deletePath(convId, confirmDelete.path).finally(() => {
            setDeleting(false);
            setConfirmDelete(null);
          });
        }}
      >
        {confirmDelete?.is_dir
          ? "The folder and all its contents will be moved to the Trash (recoverable from the Finder)."
          : "The file will be moved to the Trash (recoverable from the Finder)."}
      </ConfirmDialog>
    </div>
  );
}

const EMPTY_DIRS: Record<string, FsEntry[]> = {};
const EMPTY_FLAGS: Record<string, boolean> = {};
const EMPTY_ERRORS: Record<string, string> = {};
const EMPTY_SET: Set<string> = new Set();

interface NodeProps {
  entry: FsEntry;
  depth: number;
  dirs: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  loadingDirs: Record<string, boolean>;
  dirErrors: Record<string, string>;
  activeTab: string | null;
  editing: EditTarget | null;
  cutSet: Set<string>;
  /** Dim rows whose OWN name is a dot-name (display preference `explorerDimHidden`). */
  dimHidden: boolean;
  iconMap: IconMap | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onPinFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry) => void;
  onCommitEdit: (name: string) => void;
  onCancelEdit: () => void;
}

function TreeNode({
  entry,
  depth,
  dirs,
  expanded,
  loadingDirs,
  dirErrors,
  activeTab,
  editing,
  cutSet,
  dimHidden,
  iconMap,
  onToggleDir,
  onOpenFile,
  onPinFile,
  onContextMenu,
  onCommitEdit,
  onCancelEdit,
}: NodeProps) {
  const isOpen = entry.is_dir && !!expanded[entry.path];
  const children = isOpen ? dirs[entry.path] : undefined;
  const active = !entry.is_dir && activeTab === entry.path;
  // Only the row's OWN name dims it: the contents of a `.claude/` are ordinary
  // files, and once you have opened that folder you are working IN it.
  const hidden = dimHidden && isHiddenName(entry.name);
  const err = entry.is_dir ? dirErrors[entry.path] : undefined;
  const renaming = editing?.kind === "rename" && editing.targetPath === entry.path;
  const newHere = isOpen && editing && editing.kind !== "rename" && editing.parentPath === entry.path;

  return (
    <>
      {renaming ? (
        <EditRow
          depth={depth}
          icon={<EntryIcon entry={entry} isOpen={isOpen} iconMap={iconMap} />}
          initial={entry.name}
          onCommit={onCommitEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <button
          type="button"
          // `data-path` is how a reveal finds this row to scroll it into view.
          data-path={entry.path}
          className={
            styles.row +
            (active ? " " + styles.rowActive : "") +
            (cutSet.has(entry.path) ? " " + styles.rowCut : "") +
            (hidden ? " " + styles.rowHidden : "")
          }
          style={{ paddingLeft: depth * INDENT + 8 }}
          onClick={() => (entry.is_dir ? onToggleDir(entry.path) : onOpenFile(entry.path))}
          onDoubleClick={() => (entry.is_dir ? undefined : onPinFile(entry.path))}
          onContextMenu={(e) => onContextMenu(e, entry)}
          title={entry.name}
        >
          {entry.is_dir ? (
            <span className={styles.twisty + (isOpen ? " " + styles.twistyOpen : "")}>
              <Ico name="chev" className="sm" />
            </span>
          ) : (
            <span className={styles.twisty} />
          )}
          <EntryIcon entry={entry} isOpen={isOpen} iconMap={iconMap} />
          <span className={styles.rowName}>{entry.name}</span>
        </button>
      )}
      {err ? (
        <div
          className={styles.treeError}
          style={{ paddingLeft: (depth + 1) * INDENT + 22 }}
          title={err}
        >
          <Ico name="alert" className="sm" />
          Unable to read.
        </div>
      ) : null}
      {newHere ? (
        <EditRow
          depth={depth + 1}
          icon={<NewEntryIcon kind={editing.kind === "newDir" ? "newDir" : "newFile"} />}
          initial=""
          onCommit={onCommitEdit}
          onCancel={onCancelEdit}
        />
      ) : null}
      {isOpen && children === undefined && loadingDirs[entry.path] ? (
        <div className={styles.treeLoading} style={{ paddingLeft: (depth + 1) * INDENT + 22 }}>
          …
        </div>
      ) : null}
      {isOpen && children
        ? children.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              dirs={dirs}
              expanded={expanded}
              loadingDirs={loadingDirs}
              dirErrors={dirErrors}
              activeTab={activeTab}
              editing={editing}
              cutSet={cutSet}
              dimHidden={dimHidden}
              iconMap={iconMap}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onPinFile={onPinFile}
              onContextMenu={onContextMenu}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          ))
        : null}
    </>
  );
}
