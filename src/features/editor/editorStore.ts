// State for the lightweight editor panel: the panel's layout (open / split
// orientation / sizes — global, persisted) and, per conversation, its file tree
// (lazily expanded), open tabs and file buffers.
//
// Identity: keyed by a conversation's STABLE id (never the live `session-N`
// handle), like every other read path in the app. The tree root is a cwd, which
// can MOVE mid-conversation (the agent enters a worktree) — when it does we reset
// that conversation's tree to the new root.
//
// Conflict policy (agreed with the user): the on-disk file is watched live. If
// the editor buffer is clean, an external write (e.g. the agent edits the file)
// reloads it in place. If the buffer has UNSAVED edits, we never clobber them —
// we keep the user's text and surface a "modified on disk" banner offering to
// reload or keep. Saving is autosave (debounced) plus Cmd+S.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands } from "../../ipc/client";
import type { FileStat, FsEntry } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import { baseName, dirName, imageMimeForPath, isImagePath, isPdfPath, languageForPath } from "./language";
import { isWithin, joinPath, uniqueDest, validateName } from "./fileOps";

/** Debounce before an edited buffer is autosaved to disk (ms). */
const AUTOSAVE_MS = 1000;

export type SplitOrientation = "row" | "column"; // side-by-side | stacked

/** What a file looked like on disk when a buffer's bytes were read: the cheap
 *  identity (size + mtime) we can re-check with a `stat`, without re-reading the
 *  content. See `diskStampChanged`. */
export interface DiskStamp {
  size: number;
  /** Ms since the epoch, or null when the platform reported none. */
  mtimeMs: number | null;
}

/**
 * Whether a fresh `stat` says a buffer's bytes are out of date and must be re-read.
 *
 * Biased towards re-reading: an unknown stamp, or a path that no longer stats,
 * both answer "changed". A stale tab shown as current is a silent lie, while a
 * needless re-read costs one file read — and for a vanished/unreadable file the
 * read is exactly what surfaces the real reason to the user.
 *
 * Size is the primary signal; mtime catches a same-size rewrite. When either side
 * has no mtime (filesystem/platform doesn't report one) size stands alone — the
 * best available answer without hashing the content.
 */
export function diskStampChanged(stamp: DiskStamp | null, stat: FileStat): boolean {
  if (!stamp || !stat.exists) return true;
  if (stat.size !== stamp.size) return true;
  if (stat.mtime_ms === null || stamp.mtimeMs === null) return false;
  // `!==`, not `>`: a restore or a `git checkout` can move mtime BACKWARDS, and
  // that is just as much a change as a newer one.
  return stat.mtime_ms !== stamp.mtimeMs;
}

/** The disk stamp carried by a completed read (`readFile` / `readImage`). */
function stampOf(read: { size: number; mtime_ms: number | null }): DiskStamp {
  return { size: read.size, mtimeMs: read.mtime_ms };
}

export interface FileBuffer {
  path: string;
  name: string;
  language: string;
  /** Current editor text (the edit surface). */
  content: string;
  /** Last text known to be on disk (saved or freshly loaded). dirty = content≠saved. */
  saved: string;
  dirty: boolean;
  loading: boolean;
  /** Non-null when the file couldn't be read (e.g. deleted on disk). */
  error: string | null;
  binary: boolean;
  tooLarge: boolean;
  /** This path is a known image extension: rendered in the ImageViewer, never
   *  Monaco. Set from the path up front (before the bytes load). */
  isImage: boolean;
  /** A ready-to-use `data:<mime>;base64,…` URL for an image buffer (null until
   *  loaded, and always null for non-image buffers). */
  imageDataUrl: string | null;
  /** Image byte size on disk (for the viewer's info line); null until loaded. */
  imageSize: number | null;
  /** This path is a PDF: rendered with pdf.js (PdfViewer), never Monaco. Set from
   *  the path up front (before the bytes load). */
  isPdf: boolean;
  /** Base64 of the PDF bytes (no `data:` prefix) once loaded — fed to pdf.js. Null
   *  until loaded, when too large, and for non-PDF buffers. */
  pdfBase64: string | null;
  /** Per-tab image view, preserved when switching tabs and back: the zoom
   *  multiplier over "fit" and the pan offset (px). Undefined = the default fit
   *  view (zoom 1, centered). */
  imageZoom?: number;
  imageOffset?: { x: number; y: number };
  /** The last on-disk state this buffer has SEEN (not necessarily what it shows —
   *  a dirty buffer keeps the user's text while having seen a newer disk version).
   *  The staleness check stats the path and compares against this, so an untouched
   *  tab costs a syscall instead of a full re-read. Null until loaded / when a read
   *  failed — which reads as "unknown, re-read it" (see `diskStampChanged`). */
  diskStamp: DiskStamp | null;
  /** An external write arrived while the buffer was dirty (banner shown). */
  diskChanged: boolean;
  /** The pending external content for the "reload" action (null otherwise). */
  diskContent: string | null;
  /** Markdown only: show the rendered preview instead of the source. */
  preview: boolean;
  /**
   * A one-shot "jump to this line" request (from a clicked file mention),
   * consumed once by MonacoView then cleared. `seq` is a monotonic nonce so a
   * repeat click on the SAME line still re-fires the reveal.
   */
  pendingReveal: { line: number; column: number; seq: number } | null;
}

/** What kind of inline tree edit is in progress (the input the FileTree shows). */
export type EditKind = "newFile" | "newDir" | "rename";

/** An in-progress inline edit in the tree: a "new file/folder" input inside a
 *  directory, or a rename input over an existing node. */
export interface EditTarget {
  kind: EditKind;
  /** The directory the new entry goes in / the renamed item currently lives in. */
  parentPath: string;
  /** The existing path being renamed (rename only). */
  targetPath?: string;
  /** The input's initial value (basename for rename, "" for a new entry). */
  initial: string;
}

interface ConvEditor {
  /** The tree root (a cwd). Reset wipes tree state when this moves. */
  root: string;
  /** Loaded directory listings, keyed by absolute dir path (presence = loaded). */
  dirs: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  loadingDirs: Record<string, boolean>;
  /** Read error per directory path (surfaced in the tree; also stops the
   *  auto-load effect from retrying a failing read forever). */
  dirErrors: Record<string, string>;
  /** The single in-progress inline edit (new file/folder or rename), or null. */
  editing: EditTarget | null;
  /** Open tab paths, in tab order. */
  tabs: string[];
  activeTab: string | null;
  buffers: Record<string, FileBuffer>;
  /**
   * The single "preview" (temporary) tab, à la VS Code: a single-click opens a
   * file here (shown in italics) and the next single-click REPLACES it. A
   * double-click — on the file or the tab — or any edit promotes it to a pinned
   * tab. Null when there is no preview tab.
   */
  previewTab: string | null;
}

/** The app-internal file clipboard for cut/copy/paste in the explorer (paths +
 *  whether a paste should copy or move). Module-global like VS Code's, so a paste
 *  can target a different conversation's tree. */
export interface FileClipboard {
  paths: string[];
  mode: "copy" | "cut";
}

/**
 * The artifact currently open in the side-region VIEWER (a rendered preview of a Claude
 * `Artifact` — HTML in a sandboxed iframe, Markdown via the thread renderer). In-memory /
 * transient (NOT persisted): it points at an EPHEMERAL temp file, so it must not outlive the
 * session. Takes over the side region while set, mutually exclusive with Git, and cleared by ANY
 * side-region toggle (editor / terminal / Git) in EITHER direction — see `clearArtifact` for why
 * "only when opening" made a toggle press do nothing visible.
 */
export interface ArtifactView {
  /** The conversation this artifact belongs to (the viewer only shows on its own conv). */
  convId: string;
  title: string;
  favicon: string | null;
  /** Hosted claude.ai URL — the durable copy, for "open in browser" and the missing-file fallback. */
  url: string | null;
  /** Local temp file to render, or null (→ the viewer shows the open-in-browser fallback). */
  filePath: string | null;
  kind: "html" | "md";
}

interface EditorState {
  // ---- Global layout (persisted) ----
  // The "side region" (right of, or below, the conversation) holds the editor
  // and/or the integrated terminal. `open` = editor shown; `terminalOpen` =
  // terminal shown. `orientation` places the WHOLE side region (row = right,
  // column = below). `editorFraction` is the side region's share of the main
  // area; `terminalFraction` splits the side region between editor and terminal
  // when both are open.
  open: boolean;
  terminalOpen: boolean;
  /** Git panel shown — a 3rd region mode that takes over the side region while on. */
  gitOpen: boolean;
  orientation: SplitOrientation;
  /** Orientation of the Git workspace, independent of the editor/terminal one:
   *  `column` = horizontal divider (conv+diff on top, history/files strip below);
   *  `row` = vertical divider (conv left, the git region on the right). */
  gitOrientation: SplitOrientation;
  /** Fraction of the main area given to the side region (0..1). */
  editorFraction: number;
  /** Fraction of the side region given to the terminal when both panes are open (0..1). */
  terminalFraction: number;
  /** Git workspace 2x2 fractions (persisted). Height of the bottom history/files
   *  strip, width of the minimized conversation column, and width of the history
   *  pane within the strip — each 0..1. */
  gitStripFraction: number;
  gitConvFraction: number;
  gitStripLeftFraction: number;
  /** Width fraction of the git-history column in the 3-column (row) layout. */
  gitHistFraction: number;
  /** File-tree column width, px. */
  treeWidth: number;
  /** The file tree is hidden (focus-on-files mode); the editor still shows. */
  treeCollapsed: boolean;

  // ---- Artifact viewer (in-memory, transient) ----
  /** The artifact open in the side-region viewer, or null. Cleared by every side-region toggle
   *  (`toggleOpen`/`setOpen`, `toggleTerminal`/`setTerminalOpen`, `toggleGit`/`setGitOpen`),
   *  whichever way they flip. */
  artifactView: ArtifactView | null;
  /** Open an artifact in the side-region viewer (closes Git FIRST — see the ordering trap in the
   *  implementation — then takes over the side region). */
  openArtifact: (view: ArtifactView) => void;
  /** Close the artifact viewer (the side region falls back to editor/terminal if open). */
  closeArtifact: () => void;

  // ---- Per conversation ----
  byConv: Record<string, ConvEditor>;

  /** The explorer's cut/copy clipboard (paths + copy|cut), or null. Global, so a
   *  paste can target any conversation's tree. */
  clipboard: FileClipboard | null;

  // ---- Layout actions ----
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleGit: () => void;
  setGitOpen: (open: boolean) => void;
  setOrientation: (o: SplitOrientation) => void;
  setGitOrientation: (o: SplitOrientation) => void;
  setEditorFraction: (f: number) => void;
  setTerminalFraction: (f: number) => void;
  setGitStripFraction: (f: number) => void;
  setGitConvFraction: (f: number) => void;
  setGitStripLeftFraction: (f: number) => void;
  setGitHistFraction: (f: number) => void;
  setTreeWidth: (w: number) => void;
  setTreeCollapsed: (collapsed: boolean) => void;
  toggleTree: () => void;

  // ---- Tree ----
  /** Initialise a conversation's tree at `root`, resetting it if the root moved. */
  ensureConv: (convId: string, root: string) => void;
  toggleDir: (convId: string, path: string) => Promise<void>;

  // ---- Explorer mutations (context menu) ----
  /** Begin creating a new file/folder inside `parentDir`: expands it and shows an
   *  inline input. `commitEdit` finishes; `cancelEdit` aborts. */
  startCreate: (convId: string, parentDir: string, kind: "newFile" | "newDir") => void;
  /** Begin renaming `path`: shows an inline input pre-filled with its basename. */
  startRename: (convId: string, path: string) => void;
  /** Cancel the in-progress inline edit (Escape / empty / blur-without-change). */
  cancelEdit: (convId: string) => void;
  /** Finish the in-progress inline edit with `name` (create or rename on disk). An
   *  empty/unchanged name is treated as a cancel. */
  commitEdit: (convId: string, name: string) => Promise<void>;
  /** Move `path` to the OS trash (recoverable). Closes any open tab under it. */
  deletePath: (convId: string, path: string) => Promise<void>;
  /** Put `paths` on the explorer clipboard for a later paste (copy | cut). */
  setClipboard: (paths: string[], mode: "copy" | "cut") => void;
  /** Paste the clipboard into `targetDir`: copies (or moves, for cut) each entry,
   *  resolving a non-colliding name. A cut is consumed once pasted. */
  pasteInto: (convId: string, targetDir: string) => Promise<void>;

  // ---- Tabs / buffers ----
  /** Open a file. `preview` (single-click) uses the reusable temporary tab;
   *  omitting it / false (double-click) opens a pinned tab. `reveal` jumps the
   *  editor to a line (and forces markdown to source mode so Monaco mounts). */
  openFile: (
    convId: string,
    path: string,
    opts?: { preview?: boolean; reveal?: { line: number; column?: number } },
  ) => Promise<void>;
  /**
   * Open a file mention: reveal the side editor, collapse the tree (focus on the
   * file), open the file (preview tab) and optionally jump to a line. The single
   * entry point used by clickable file mentions in the conversation.
   */
  revealInEditor: (
    convId: string,
    cwd: string,
    path: string,
    opts?: { line?: number; column?: number },
  ) => void;
  /** Clear a buffer's consumed one-shot reveal request. */
  clearReveal: (convId: string, path: string) => void;
  /** Promote a path's tab to pinned (no longer the reusable preview tab). */
  pinTab: (convId: string, path: string) => void;
  closeTab: (convId: string, path: string) => void;
  selectTab: (convId: string, path: string) => void;
  setContent: (convId: string, path: string, content: string) => void;
  saveBuffer: (convId: string, path: string) => Promise<void>;
  togglePreview: (convId: string, path: string) => void;
  /** Persist an image tab's zoom/pan so it survives switching away and back. */
  setImageView: (convId: string, path: string, zoom: number, offset: { x: number; y: number }) => void;

  // ---- Live filesystem changes ----
  onExternalChange: (convId: string, paths: string[]) => Promise<void>;
  /** Bring every open tab of a conversation back in line with the disk — ALL kinds
   *  (text, image, PDF) — applying the same conflict policy as a live change. One
   *  batched `stat` decides which tabs actually need re-reading, so this stays cheap
   *  enough to run both when the OS watch (re)points at this cwd (conversation
   *  switch, editor reopen, worktree move) and on a periodic tick. It is what covers
   *  every change no watch reports: another conversation's tabs, a closed panel, an
   *  ignored dir (build/, dist/…), a file outside the watched cwd. Tree dirs are
   *  deliberately NOT resynced here (see the implementation note). */
  resyncOpenBuffers: (convId: string) => Promise<void>;
  /** Apply the pending on-disk content over the local buffer ("reload"). */
  reloadFromDisk: (convId: string, path: string) => void;
  /** Dismiss the "modified on disk" banner, keeping local edits. */
  keepLocal: (convId: string, path: string) => void;
}

// ---- Layout persistence (localStorage, mirrors store/notifications.ts) -------

const LS_KEY = "tosse:editor";

interface LayoutPrefs {
  open: boolean;
  terminalOpen: boolean;
  gitOpen: boolean;
  orientation: SplitOrientation;
  gitOrientation: SplitOrientation;
  editorFraction: number;
  terminalFraction: number;
  gitStripFraction: number;
  gitConvFraction: number;
  gitStripLeftFraction: number;
  gitHistFraction: number;
  treeWidth: number;
  /** The file tree is collapsed (focus-on-files mode) — the editor still shows. */
  treeCollapsed: boolean;
}

const DEFAULT_LAYOUT: LayoutPrefs = {
  open: false,
  terminalOpen: false,
  gitOpen: false,
  orientation: "row",
  gitOrientation: "row",
  editorFraction: 0.42,
  terminalFraction: 0.4,
  gitStripFraction: 0.25,
  gitConvFraction: 0.4,
  gitStripLeftFraction: 0.5,
  gitHistFraction: 0.3,
  treeWidth: 220,
  treeCollapsed: false,
};

function loadLayout(): LayoutPrefs {
  if (typeof localStorage === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const p = JSON.parse(raw) as Partial<LayoutPrefs>;
    return {
      open: typeof p.open === "boolean" ? p.open : DEFAULT_LAYOUT.open,
      terminalOpen: typeof p.terminalOpen === "boolean" ? p.terminalOpen : DEFAULT_LAYOUT.terminalOpen,
      gitOpen: typeof p.gitOpen === "boolean" ? p.gitOpen : DEFAULT_LAYOUT.gitOpen,
      orientation: p.orientation === "column" ? "column" : "row",
      gitOrientation: p.gitOrientation === "column" ? "column" : "row",
      editorFraction:
        typeof p.editorFraction === "number" ? clamp(p.editorFraction, 0.15, 0.85) : DEFAULT_LAYOUT.editorFraction,
      terminalFraction:
        typeof p.terminalFraction === "number" ? clamp(p.terminalFraction, 0.15, 0.85) : DEFAULT_LAYOUT.terminalFraction,
      // Clamp bounds MUST match the setters below (the gatekeeper for what gets
      // persisted), else a saved split jumps on reload.
      gitStripFraction:
        typeof p.gitStripFraction === "number" ? clamp(p.gitStripFraction, 0.12, 0.6) : DEFAULT_LAYOUT.gitStripFraction,
      gitConvFraction:
        typeof p.gitConvFraction === "number" ? clamp(p.gitConvFraction, 0.15, 0.6) : DEFAULT_LAYOUT.gitConvFraction,
      gitStripLeftFraction:
        typeof p.gitStripLeftFraction === "number" ? clamp(p.gitStripLeftFraction, 0.2, 0.8) : DEFAULT_LAYOUT.gitStripLeftFraction,
      gitHistFraction:
        typeof p.gitHistFraction === "number" ? clamp(p.gitHistFraction, 0.18, 0.5) : DEFAULT_LAYOUT.gitHistFraction,
      treeWidth: typeof p.treeWidth === "number" ? clamp(p.treeWidth, 120, 600) : DEFAULT_LAYOUT.treeWidth,
      treeCollapsed: typeof p.treeCollapsed === "boolean" ? p.treeCollapsed : DEFAULT_LAYOUT.treeCollapsed,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(s: EditorState): void {
  if (typeof localStorage === "undefined") return;
  const prefs: LayoutPrefs = {
    open: s.open,
    terminalOpen: s.terminalOpen,
    gitOpen: s.gitOpen,
    orientation: s.orientation,
    gitOrientation: s.gitOrientation,
    editorFraction: s.editorFraction,
    terminalFraction: s.terminalFraction,
    gitStripFraction: s.gitStripFraction,
    gitConvFraction: s.gitConvFraction,
    gitStripLeftFraction: s.gitStripLeftFraction,
    gitHistFraction: s.gitHistFraction,
    treeWidth: s.treeWidth,
    treeCollapsed: s.treeCollapsed,
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full / unavailable — layout just won't persist */
  }
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Await an IPC command, turning a thrown transport rejection into a normal error
 * Result. The generated bindings RETHROW genuine `Error`s (only string command
 * errors become error Results), so without this an unexpected failure would
 * reject the action and leave UI stuck (e.g. a tab loading forever). With it,
 * every command error — string or thrown — flows through the caller's
 * `status !== "ok"` branch and is surfaced, never swallowed.
 */
async function safeCmd<T>(
  run: () => Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>,
): Promise<{ status: "ok"; data: T } | { status: "error"; error: string }> {
  try {
    return await run();
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Autosave timers (module-level, not store state) ------------------------

// Monotonic nonce for line-reveal requests, so re-clicking the SAME line re-fires.
let revealSeq = 0;

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const timerKey = (convId: string, path: string) => `${convId} ${path}`;

function clearAutosave(convId: string, path: string): void {
  const k = timerKey(convId, path);
  const t = autosaveTimers.get(k);
  if (t) {
    clearTimeout(t);
    autosaveTimers.delete(k);
  }
}

/** Clear every pending autosave at `path` OR under it (for a directory). Called
 *  BEFORE a destructive op (delete / rename / move) so a debounced timer can't fire
 *  mid-op and write the buffer back to its OLD path — which would resurrect a file
 *  we just deleted, or recreate one we just moved away. */
function clearAutosaveUnder(convId: string, path: string): void {
  const exact = timerKey(convId, path);
  const prefix = exact + "/";
  for (const key of [...autosaveTimers.keys()]) {
    if (key === exact || key.startsWith(prefix)) {
      clearTimeout(autosaveTimers.get(key)!);
      autosaveTimers.delete(key);
    }
  }
}

// ---- Immutable update helpers ----------------------------------------------

function emptyConv(root: string): ConvEditor {
  return {
    root,
    dirs: {},
    expanded: {},
    loadingDirs: {},
    dirErrors: {},
    editing: null,
    tabs: [],
    activeTab: null,
    buffers: {},
    previewTab: null,
  };
}

function fileBufferFrom(path: string): FileBuffer {
  return {
    path,
    name: baseName(path),
    language: languageForPath(path),
    content: "",
    saved: "",
    dirty: false,
    loading: true,
    error: null,
    binary: false,
    tooLarge: false,
    isImage: isImagePath(path),
    imageDataUrl: null,
    imageSize: null,
    isPdf: isPdfPath(path),
    pdfBase64: null,
    diskStamp: null,
    diskChanged: false,
    diskContent: null,
    preview: false,
    pendingReveal: null,
  };
}

/** Build a `data:` URL the webview can render from base64 image bytes. */
function imageDataUrlFor(path: string, base64: string): string {
  const mime = imageMimeForPath(path) ?? "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

export const useEditorStore = create<EditorState>()((set, get) => {
  const layout = loadLayout();

  /** Replace one conversation's slice and persist nothing (per-conv is in-memory). */
  function patchConv(convId: string, fn: (c: ConvEditor) => ConvEditor): void {
    set((s) => {
      const cur = s.byConv[convId];
      if (!cur) return s;
      return { byConv: { ...s.byConv, [convId]: fn(cur) } };
    });
  }

  /** Replace one buffer within a conversation. */
  function patchBuffer(convId: string, path: string, fn: (b: FileBuffer) => FileBuffer): void {
    patchConv(convId, (c) => {
      const b = c.buffers[path];
      if (!b) return c;
      return { ...c, buffers: { ...c.buffers, [path]: fn(b) } };
    });
  }

  /** Persist layout after any layout mutation. */
  function withLayout(patch: Partial<LayoutPrefs>): void {
    set(patch as Partial<EditorState>);
    saveLayout(get());
  }

  /** Surface a file-operation failure on the app-level error banner (the unified
   *  "zero silent error" channel) — these aren't tied to a conversation turn. */
  function reportFsError(message: string, detail?: string): void {
    console.error(message, detail ?? "");
    useAppErrors.getState().pushError(message, detail ?? null);
  }

  /** Re-read a directory we've already loaded, so a create/rename/delete shows in
   *  the tree immediately (without waiting on the debounced fs watcher). No-op for
   *  a directory that isn't loaded (it'll read fresh when expanded). */
  async function refreshDir(convId: string, dir: string): Promise<void> {
    const conv = get().byConv[convId];
    if (!conv || conv.dirs[dir] === undefined) return;
    const res = await safeCmd(() => commands.readDir(dir));
    if (res.status === "ok") {
      patchConv(convId, (c) => (c.dirs[dir] !== undefined ? { ...c, dirs: { ...c.dirs, [dir]: res.data } } : c));
    } else {
      // The op succeeded but the re-read failed → the tree now shows a STALE
      // listing. Never let that pass silently (zero-silent-error): surface it on
      // the app banner so the user knows the view may be out of date and can act.
      reportFsError("Tree not refreshed — it may be out of date.", res.error);
    }
  }

  /** Re-read one OPEN file from disk and apply the conflict policy: clean buffers
   *  live-reload in place, dirty ones surface a "modified on disk" banner, images
   *  and PDFs always refresh their bytes. Shared by the live watch
   *  (`onExternalChange`) and the catch-up resync (`resyncOpenBuffers`). No-op for
   *  a path that isn't an open buffer. */
  async function reloadTab(convId: string, path: string): Promise<void> {
    const buf = get().byConv[convId]?.buffers[path];
    if (!buf) return;
    // Images are never editable (no dirty state) → always live-reload the bytes.
    // A fresh data URL forces the <img> to repaint the new content.
    if (buf.isImage) {
      const res = await safeCmd(() => commands.readImage(path));
      if (res.status !== "ok") {
        // Clear the stamp: the buffer no longer matches any known disk state, so the
        // next check must re-read rather than conclude "unchanged" from a stale stamp.
        patchBuffer(convId, path, (b) => ({ ...b, error: "Image unavailable on disk.", diskStamp: null }));
        return;
      }
      const img = res.data;
      patchBuffer(convId, path, (b) => ({
        ...b,
        error: null,
        tooLarge: img.too_large,
        imageSize: img.size,
        imageDataUrl: img.too_large ? null : imageDataUrlFor(path, img.data_base64),
        diskStamp: stampOf(img),
      }));
      return;
    }
    // PDFs (like images) are never editable → always live-reload the bytes; a fresh
    // base64 re-triggers the PdfViewer's render effect.
    if (buf.isPdf) {
      const res = await safeCmd(() => commands.readImage(path));
      if (res.status !== "ok") {
        patchBuffer(convId, path, (b) => ({ ...b, error: "PDF unavailable on disk.", diskStamp: null }));
        return;
      }
      const doc = res.data;
      patchBuffer(convId, path, (b) => ({
        ...b,
        error: null,
        tooLarge: doc.too_large,
        imageSize: doc.size,
        pdfBase64: doc.too_large ? null : doc.data_base64,
        diskStamp: stampOf(doc),
      }));
      return;
    }
    const res = await safeCmd(() => commands.readFile(path));
    if (res.status !== "ok") {
      // The file likely vanished — flag it but keep the tab/content.
      patchBuffer(convId, path, (b) => ({ ...b, error: "File unavailable on disk.", diskStamp: null }));
      return;
    }
    const f = res.data;
    patchBuffer(convId, path, (b) => {
      // Whatever branch we take below, the buffer now knows what the disk looks
      // like — including the "no real change" one, whose whole point is that the
      // content matches even though the stamp (an autosave's own echo, a rewrite
      // with identical bytes) moved.
      const stamped = { ...b, diskStamp: stampOf(f) };
      // No real change vs what we already have on disk → ignore (this also
      // absorbs the echo of our own save).
      if (f.content === b.saved) return { ...stamped, diskChanged: false, diskContent: null };
      // Unsaved local edits: never clobber — surface the on-disk version via the
      // banner. This MUST be checked before the binary/too-large branch below:
      // if the on-disk file turned binary or >MAX_FILE_BYTES, that branch would
      // otherwise overwrite the buffer with the (empty) disk content and drop the
      // user's edits with no banner and no error — a silent data loss.
      if (b.dirty) return { ...stamped, diskChanged: true, diskContent: f.content };
      if (b.binary || f.binary || f.too_large) {
        return { ...stamped, binary: f.binary, tooLarge: f.too_large, saved: f.content, content: f.content };
      }
      // Clean buffer: live-reload in place.
      return { ...stamped, content: f.content, saved: f.content, dirty: false, error: null };
    });
  }

  /** Drop cached tree state for `path` and everything beneath it (after a delete
   *  or a move), so a stale listing/expansion never lingers. */
  function dropTreeCache(convId: string, path: string): void {
    patchConv(convId, (c) => {
      const prune = <T>(rec: Record<string, T>): Record<string, T> => {
        const next = { ...rec };
        for (const key of Object.keys(next)) {
          if (isWithin(path, key)) delete next[key];
        }
        return next;
      };
      return { ...c, dirs: prune(c.dirs), expanded: prune(c.expanded), dirErrors: prune(c.dirErrors) };
    });
  }

  /** Rebase open buffers/tabs after `from` was renamed/moved to `to`: the buffer at
   *  `from` itself, AND every open file UNDER `from` when a DIRECTORY moved, follow
   *  to the matching path under `to` — keeping the tab and its (possibly unsaved)
   *  content instead of dropping it. Pending autosaves migrate with them, so an
   *  unsaved edit lands on the new path (never the old one). */
  function retargetOpenBuffers(convId: string, from: string, to: string): void {
    const conv = get().byConv[convId];
    if (!conv) return;
    const moves: Array<{ oldPath: string; newPath: string }> = [];
    for (const p of Object.keys(conv.buffers)) {
      if (p === from) moves.push({ oldPath: p, newPath: to });
      else if (p.startsWith(from + "/")) moves.push({ oldPath: p, newPath: to + p.slice(from.length) });
    }
    if (moves.length === 0) return;
    const remap = new Map(moves.map((m) => [m.oldPath, m.newPath]));
    patchConv(convId, (c) => {
      const buffers = { ...c.buffers };
      for (const { oldPath, newPath } of moves) {
        const b = buffers[oldPath];
        if (!b) continue;
        delete buffers[oldPath];
        buffers[newPath] = { ...b, path: newPath, name: baseName(newPath), language: languageForPath(newPath) };
      }
      const map = (t: string) => remap.get(t) ?? t;
      return {
        ...c,
        buffers,
        tabs: c.tabs.map(map),
        activeTab: c.activeTab ? map(c.activeTab) : c.activeTab,
        previewTab: c.previewTab ? map(c.previewTab) : c.previewTab,
      };
    });
    // Migrate autosave: drop the old timers; reschedule a save under the NEW path
    // for any buffer that's still dirty (the edit follows the file to its new home).
    for (const { oldPath, newPath } of moves) {
      clearAutosave(convId, oldPath);
      const b = get().byConv[convId]?.buffers[newPath];
      if (b && b.dirty && !b.binary && !b.tooLarge) {
        autosaveTimers.set(
          timerKey(convId, newPath),
          setTimeout(() => {
            autosaveTimers.delete(timerKey(convId, newPath));
            void get().saveBuffer(convId, newPath);
          }, AUTOSAVE_MS),
        );
      }
    }
  }

  /** Close any open tab at or under `path` (used when it's deleted/moved away). */
  function closeBuffersUnder(convId: string, path: string): void {
    const conv = get().byConv[convId];
    if (!conv) return;
    for (const tab of [...conv.tabs]) {
      if (isWithin(path, tab)) get().closeTab(convId, tab);
    }
  }

  // ANY side-region toggle (editor / terminal / git) clears the transient artifact viewer, in
  // BOTH directions — closing included. MainArea computes the region's visibility as
  // `open || terminalOpen || showArtifact`, so the viewer holds the side region open on its own:
  // a toggle that only cleared it when OPENING made ⌘B (editor) flip `open` to false while the
  // viewer stayed on screen — the press produced NO visible change and a second one was needed.
  // Clearing unconditionally keeps the rule "one press = one visible effect".
  const clearArtifact = () => {
    if (get().artifactView) set({ artifactView: null });
  };

  return {
    ...layout,
    byConv: {},
    clipboard: null,
    artifactView: null,

    openArtifact: (view) => {
      // ⚠️ ORDER MATTERS — close Git BEFORE setting the view, never after. `setGitOpen` clears the
      // artifact view UNCONDITIONALLY (see clearArtifact), so the old "set, then close Git"
      // ordering would immediately wipe the artifact we were just asked to open. Do not swap
      // these two lines back.
      if (get().gitOpen) get().setGitOpen(false); // viewer and Git are mutually exclusive
      set({ artifactView: view });
    },
    closeArtifact: () => set({ artifactView: null }),

    // Git is a mutually-exclusive mode: opening it hides the editor/terminal
    // region, and opening the editor or terminal closes Git — so a lit toggle
    // never contradicts what's actually shown. Editor + terminal still coexist.
    // Every one of these also drops the artifact viewer (both directions — see clearArtifact).
    toggleOpen: () => {
      const open = !get().open;
      clearArtifact();
      withLayout(open ? { open: true, gitOpen: false } : { open: false });
    },
    setOpen: (open) => {
      clearArtifact();
      withLayout(open ? { open: true, gitOpen: false } : { open: false });
    },
    toggleTerminal: () => {
      const terminalOpen = !get().terminalOpen;
      clearArtifact();
      withLayout(terminalOpen ? { terminalOpen: true, gitOpen: false } : { terminalOpen: false });
    },
    setTerminalOpen: (terminalOpen) => {
      clearArtifact();
      withLayout(terminalOpen ? { terminalOpen: true, gitOpen: false } : { terminalOpen: false });
    },
    toggleGit: () => {
      const gitOpen = !get().gitOpen;
      clearArtifact();
      withLayout(gitOpen ? { gitOpen: true, open: false, terminalOpen: false } : { gitOpen: false });
    },
    setGitOpen: (gitOpen) => {
      clearArtifact();
      withLayout(gitOpen ? { gitOpen: true, open: false, terminalOpen: false } : { gitOpen: false });
    },
    setOrientation: (orientation) => withLayout({ orientation }),
    setGitOrientation: (gitOrientation) => withLayout({ gitOrientation }),
    setEditorFraction: (f) => withLayout({ editorFraction: clamp(f, 0.15, 0.85) }),
    setTerminalFraction: (f) => withLayout({ terminalFraction: clamp(f, 0.15, 0.85) }),
    setGitStripFraction: (f) => withLayout({ gitStripFraction: clamp(f, 0.12, 0.6) }),
    setGitConvFraction: (f) => withLayout({ gitConvFraction: clamp(f, 0.15, 0.6) }),
    setGitStripLeftFraction: (f) => withLayout({ gitStripLeftFraction: clamp(f, 0.2, 0.8) }),
    setGitHistFraction: (f) => withLayout({ gitHistFraction: clamp(f, 0.18, 0.5) }),
    setTreeWidth: (w) => withLayout({ treeWidth: clamp(w, 120, 600) }),
    setTreeCollapsed: (treeCollapsed) => withLayout({ treeCollapsed }),
    toggleTree: () => withLayout({ treeCollapsed: !get().treeCollapsed }),

    ensureConv: (convId, root) => {
      const cur = get().byConv[convId];
      if (cur && cur.root === root) return; // already at this root
      // New conversation, or its cwd moved (worktree): (re)start at the new root.
      // Keep open tabs across a root move only if their files are still in scope?
      // Simpler + predictable: a root move resets the tree but KEEPS open tabs
      // (absolute paths stay valid until the file is gone — the watcher handles
      // deletion). On first init there are no tabs anyway.
      set((s) => {
        const existing = s.byConv[convId];
        const next: ConvEditor = existing
          ? {
              ...emptyConv(root),
              tabs: existing.tabs,
              activeTab: existing.activeTab,
              buffers: existing.buffers,
              previewTab: existing.previewTab,
            }
          : emptyConv(root);
        return { byConv: { ...s.byConv, [convId]: next } };
      });
    },

    toggleDir: async (convId, path) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      const isLoaded = conv.dirs[path] !== undefined;
      if (isLoaded) {
        patchConv(convId, (c) => ({ ...c, expanded: { ...c.expanded, [path]: !c.expanded[path] } }));
        return;
      }
      if (conv.loadingDirs[path]) return;
      // Clear any prior error on (re)try; mark loading.
      patchConv(convId, (c) => {
        const dirErrors = { ...c.dirErrors };
        delete dirErrors[path];
        return { ...c, dirErrors, loadingDirs: { ...c.loadingDirs, [path]: true } };
      });
      const res = await safeCmd(() => commands.readDir(path));
      patchConv(convId, (c) => {
        const loadingDirs = { ...c.loadingDirs };
        delete loadingDirs[path];
        if (res.status !== "ok") {
          // Surface the error in the tree AND record it so the auto-load effect
          // doesn't retry a failing read in a tight loop. Click retries.
          console.error("readDir failed:", res.error);
          return { ...c, loadingDirs, dirErrors: { ...c.dirErrors, [path]: res.error } };
        }
        const dirErrors = { ...c.dirErrors };
        delete dirErrors[path];
        return {
          ...c,
          loadingDirs,
          dirErrors,
          dirs: { ...c.dirs, [path]: res.data },
          expanded: { ...c.expanded, [path]: true },
        };
      });
    },

    // ---- Explorer mutations (context menu) ----

    startCreate: (convId, parentDir, kind) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      const isRoot = parentDir === conv.root;
      const arm = () =>
        patchConv(convId, (c) => ({
          ...c,
          expanded: isRoot ? c.expanded : { ...c.expanded, [parentDir]: true },
          editing: { kind, parentPath: parentDir, initial: "" },
        }));
      // The dir must be loaded for the inline input to render inside it. Load it
      // first if needed (toggleDir loads + expands), then arm the editor — but ONLY
      // if the read succeeded. On a read error toggleDir already surfaced it in the
      // tree (dirErrors); arming over an unreadable dir would show an input that
      // never renders (and let a doomed create be typed).
      if (!isRoot && conv.dirs[parentDir] === undefined) {
        void get().toggleDir(convId, parentDir).then(() => {
          if (get().byConv[convId]?.dirs[parentDir] !== undefined) arm();
        });
      } else {
        arm();
      }
    },

    startRename: (convId, path) =>
      patchConv(convId, (c) => ({
        ...c,
        editing: { kind: "rename", parentPath: dirName(path), targetPath: path, initial: baseName(path) },
      })),

    cancelEdit: (convId) => patchConv(convId, (c) => (c.editing ? { ...c, editing: null } : c)),

    commitEdit: async (convId, rawName) => {
      const conv = get().byConv[convId];
      const editing = conv?.editing;
      if (!conv || !editing) return;
      const name = rawName.trim();
      // Clear the inline input up front (the disk op + refresh run async).
      patchConv(convId, (c) => ({ ...c, editing: null }));
      if (!name) return; // empty = a deliberate cancel (legitimate, not an error)
      // A non-empty but invalid name ("/", ".", "..") is NOT a silent no-op: tell
      // the user why nothing happened instead of swallowing it.
      const invalid = validateName(name);
      if (invalid) {
        reportFsError(`Nom invalide : « ${name} »`, invalid);
        return;
      }
      const dir = editing.parentPath;
      const dest = joinPath(dir, name);

      if (editing.kind === "rename") {
        if (!editing.targetPath || name === editing.initial) return; // unchanged = no-op
        // Stop any pending autosave on the source BEFORE the move, so a debounced
        // write can't fire mid-rename and recreate the file at its old path.
        clearAutosaveUnder(convId, editing.targetPath);
        const res = await safeCmd(() => commands.renameEntry(editing.targetPath!, dest));
        if (res.status !== "ok") {
          reportFsError(`Renommage impossible : « ${baseName(editing.targetPath)} »`, res.error);
          return;
        }
        retargetOpenBuffers(convId, editing.targetPath, dest);
        dropTreeCache(convId, editing.targetPath);
        await refreshDir(convId, dir);
        return;
      }

      // New file / new folder.
      const res = await safeCmd(() =>
        editing.kind === "newDir" ? commands.createDir(dest) : commands.createFile(dest),
      );
      if (res.status !== "ok") {
        reportFsError(`Création impossible : « ${name} »`, res.error);
        return;
      }
      await refreshDir(convId, dir);
      // Open a freshly created file so the user can start editing right away.
      if (editing.kind === "newFile") void get().openFile(convId, dest, { preview: false });
    },

    deletePath: async (convId, path) => {
      // Stop any pending autosave under the target BEFORE the trash op, so a
      // debounced write can't fire mid-delete and resurrect the file.
      clearAutosaveUnder(convId, path);
      const res = await safeCmd(() => commands.deleteToTrash(path));
      if (res.status !== "ok") {
        reportFsError(`Suppression impossible : « ${baseName(path)} »`, res.error);
        return;
      }
      closeBuffersUnder(convId, path);
      dropTreeCache(convId, path);
      await refreshDir(convId, dirName(path));
    },

    setClipboard: (paths, mode) => set({ clipboard: { paths, mode } }),

    pasteInto: async (convId, targetDir) => {
      const clip = get().clipboard;
      if (!clip || clip.paths.length === 0) return;
      const movedSourceDirs = new Set<string>();
      try {
        for (const src of clip.paths) {
          // Never paste a folder into itself or its own subtree.
          if (isWithin(src, targetDir)) {
            reportFsError("Collage impossible : un dossier ne peut pas être collé dans lui-même.");
            continue;
          }
          // A cut into the SAME directory is a no-op (VS Code does nothing).
          if (clip.mode === "cut" && dirName(src) === targetDir) continue;

          // `pathExists` (the collision probe) is the one IPC call here NOT wrapped
          // by `safeCmd`; the surrounding try/catch is its safety net so a transport
          // rejection surfaces instead of vanishing as an unhandled rejection.
          const dest = await uniqueDest(targetDir, baseName(src), (p) => commands.pathExists(p));
          if (clip.mode === "cut") {
            // Stop the source's pending autosave before the move (anti-resurrection).
            clearAutosaveUnder(convId, src);
          }
          const res =
            clip.mode === "copy"
              ? await safeCmd(() => commands.copyEntry(src, dest))
              : await safeCmd(() => commands.renameEntry(src, dest));
          if (res.status !== "ok") {
            reportFsError(`Collage impossible : « ${baseName(src)} »`, res.error);
            continue;
          }
          if (clip.mode === "cut") {
            retargetOpenBuffers(convId, src, dest);
            dropTreeCache(convId, src);
            movedSourceDirs.add(dirName(src));
          }
        }
        await refreshDir(convId, targetDir);
        // A cut is consumed once pasted; refresh the dirs the items left.
        if (clip.mode === "cut") {
          for (const dir of movedSourceDirs) await refreshDir(convId, dir);
          set({ clipboard: null });
        }
      } catch (e) {
        reportFsError("Collage impossible.", e instanceof Error ? e.message : String(e));
      }
    },

    openFile: async (convId, path, opts) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      const preview = opts?.preview ?? false;
      const reveal = opts?.reveal
        ? { line: opts.reveal.line, column: opts.reveal.column ?? 1, seq: ++revealSeq }
        : null;

      // Already open: focus it (and re-arm the reveal, since the line target may
      // differ from last time). A pin request (double-click) on the current
      // preview tab promotes it to a permanent tab.
      if (conv.buffers[path]) {
        if (reveal) {
          patchBuffer(convId, path, (b) => ({
            ...b,
            pendingReveal: reveal,
            // A line jump needs Monaco, not the rendered markdown preview.
            preview: b.language === "markdown" ? false : b.preview,
          }));
        }
        if (!preview && conv.previewTab === path) {
          patchConv(convId, (c) => ({ ...c, activeTab: path, previewTab: null }));
        } else {
          get().selectTab(convId, path);
        }
        return;
      }

      // A new file opened in preview mode REUSES the single preview tab's slot
      // (replacing whatever was previewed), so single-clicking through files never
      // piles up tabs. A pinned open just appends.
      const replacing = preview && conv.previewTab && conv.buffers[conv.previewTab] ? conv.previewTab : null;
      if (replacing) clearAutosave(convId, replacing);
      patchConv(convId, (c) => {
        const buffers = { ...c.buffers, [path]: { ...fileBufferFrom(path), pendingReveal: reveal } };
        let tabs: string[];
        if (replacing) {
          delete buffers[replacing];
          const i = c.tabs.indexOf(replacing);
          tabs = i >= 0 ? [...c.tabs.slice(0, i), path, ...c.tabs.slice(i + 1)] : [...c.tabs, path];
        } else {
          tabs = [...c.tabs, path];
        }
        return { ...c, tabs, activeTab: path, buffers, previewTab: preview ? path : c.previewTab };
      });
      // Images take a separate path: read the raw bytes (base64) and render them
      // in the ImageViewer, never decoding as text / loading Monaco.
      if (isImagePath(path)) {
        const res = await safeCmd(() => commands.readImage(path));
        patchBuffer(convId, path, (b) => {
          if (res.status !== "ok") {
            return { ...b, loading: false, error: res.error };
          }
          const img = res.data;
          return {
            ...b,
            loading: false,
            tooLarge: img.too_large,
            imageSize: img.size,
            imageDataUrl: img.too_large ? null : imageDataUrlFor(path, img.data_base64),
            diskStamp: stampOf(img),
          };
        });
        return;
      }

      // PDFs take the same raw-bytes path as images (read_image is a generic
      // base64 byte reader — no image-specific logic, same 16 MiB guard), then
      // render with pdf.js in the PdfViewer rather than decoding as text.
      if (isPdfPath(path)) {
        const res = await safeCmd(() => commands.readImage(path));
        patchBuffer(convId, path, (b) => {
          if (res.status !== "ok") {
            return { ...b, loading: false, error: res.error };
          }
          const doc = res.data;
          return {
            ...b,
            loading: false,
            tooLarge: doc.too_large,
            imageSize: doc.size,
            pdfBase64: doc.too_large ? null : doc.data_base64,
            diskStamp: stampOf(doc),
          };
        });
        return;
      }

      const res = await safeCmd(() => commands.readFile(path));
      patchBuffer(convId, path, (b) => {
        if (res.status !== "ok") {
          return { ...b, loading: false, error: res.error };
        }
        const f = res.data;
        return {
          ...b,
          loading: false,
          content: f.content,
          saved: f.content,
          dirty: false,
          binary: f.binary,
          tooLarge: f.too_large,
          diskStamp: stampOf(f),
          // Markdown opens in rendered preview by default (read-first); the
          // toggle flips to source for editing. A pending line reveal forces
          // source so Monaco mounts and can jump to the line.
          preview: !reveal && !f.binary && !f.too_large && b.language === "markdown",
        };
      });
    },

    pinTab: (convId, path) =>
      patchConv(convId, (c) => (c.previewTab === path ? { ...c, previewTab: null } : c)),

    closeTab: (convId, path) => {
      clearAutosave(convId, path);
      patchConv(convId, (c) => {
        if (!c.buffers[path]) return c;
        const tabs = c.tabs.filter((p) => p !== path);
        const buffers = { ...c.buffers };
        delete buffers[path];
        let activeTab = c.activeTab;
        if (activeTab === path) {
          const idx = c.tabs.indexOf(path);
          activeTab = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1] ?? null;
        }
        return { ...c, tabs, buffers, activeTab, previewTab: c.previewTab === path ? null : c.previewTab };
      });
    },

    selectTab: (convId, path) => patchConv(convId, (c) => ({ ...c, activeTab: path })),

    revealInEditor: (convId, cwd, path, opts) => {
      // The slice must exist before openFile (it early-returns otherwise); the
      // editor panel's own mount also calls ensureConv (idempotent at same root).
      get().ensureConv(convId, cwd);
      get().setOpen(true);
      get().setTreeCollapsed(true); // focus on the file: "arbre masqué"
      void get().openFile(convId, path, {
        preview: true,
        reveal: opts?.line != null ? { line: opts.line, column: opts.column } : undefined,
      });
    },

    clearReveal: (convId, path) =>
      patchBuffer(convId, path, (b) => (b.pendingReveal ? { ...b, pendingReveal: null } : b)),

    setContent: (convId, path, content) => {
      patchBuffer(convId, path, (b) => {
        if (b.content === content) return b;
        return { ...b, content, dirty: content !== b.saved };
      });
      // Editing a preview tab pins it (à la VS Code) — your edits get a real tab.
      if (get().byConv[convId]?.previewTab === path) get().pinTab(convId, path);
      // Debounced autosave — only schedule when there's something to persist.
      const b = get().byConv[convId]?.buffers[path];
      if (b && b.dirty && !b.binary && !b.tooLarge) {
        clearAutosave(convId, path);
        autosaveTimers.set(
          timerKey(convId, path),
          setTimeout(() => {
            autosaveTimers.delete(timerKey(convId, path));
            void get().saveBuffer(convId, path);
          }, AUTOSAVE_MS),
        );
      }
    },

    saveBuffer: async (convId, path) => {
      clearAutosave(convId, path);
      const b = get().byConv[convId]?.buffers[path];
      if (!b || !b.dirty || b.binary || b.tooLarge) return;
      const content = b.content;
      const res = await safeCmd(() => commands.writeFile(path, content));
      if (res.status !== "ok") {
        console.error("writeFile failed:", res.error);
        patchBuffer(convId, path, (bb) => ({ ...bb, error: `Échec de la sauvegarde : ${res.error}` }));
        return;
      }
      // Mark clean against exactly what we wrote (the buffer may have changed again
      // while the write was in flight → it stays dirty and reschedules).
      patchBuffer(convId, path, (bb) => ({
        ...bb,
        saved: content,
        dirty: bb.content !== content,
        error: null,
        // Our own write will echo back via the watcher; clear any stale flag.
        diskChanged: false,
        diskContent: null,
      }));
    },

    togglePreview: (convId, path) => patchBuffer(convId, path, (b) => ({ ...b, preview: !b.preview })),

    setImageView: (convId, path, zoom, offset) =>
      patchBuffer(convId, path, (b) => ({ ...b, imageZoom: zoom, imageOffset: offset })),

    onExternalChange: async (convId, paths) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      const changed = new Set(paths);

      // 1) Refresh any loaded (expanded) directory that a change touched, so new /
      //    deleted files appear in the tree. We re-read the parent dir of each
      //    changed path that we've loaded (refreshDir no-ops on an unloaded dir and
      //    surfaces a failed re-read on the app banner — zero-silent-error).
      const dirsToRefresh = new Set<string>();
      for (const p of paths) {
        const parent = dirName(p);
        if (conv.dirs[parent] !== undefined) dirsToRefresh.add(parent);
      }
      for (const dir of dirsToRefresh) await refreshDir(convId, dir);

      // 2) Reload any OPEN file that changed, applying the conflict policy.
      for (const path of conv.tabs) {
        if (!changed.has(path)) continue;
        await reloadTab(convId, path);
      }
    },

    resyncOpenBuffers: async (convId) => {
      const conv = get().byConv[convId];
      if (!conv) return;
      // Catch up on on-disk changes this conversation never heard about, and the
      // periodic safety net for the ones no watch can deliver. The live fs watch is
      // SINGLE and follows the shown conversation, so it misses: another
      // conversation's tabs, everything while the panel is closed, files under an
      // ignored dir (build/, dist/, target/… — see fs::IGNORED_DIRS) and files
      // outside the watched cwd. Without this pass those tabs would sit stale
      // indefinitely, showing an old version as if it were current.
      //
      // ALL tab kinds are covered — text, images and PDFs alike. What keeps that
      // affordable is the stamp check: ONE batched `stat` for every open tab, then
      // a real read only for the ones whose size/mtime actually moved. An untouched
      // 15 MiB PDF costs a syscall, not a base64 round-trip. (An earlier version
      // skipped binaries outright to avoid the cost — which is exactly how a PDF
      // rewritten while you were on another conversation stayed stale.)
      //
      // Then the usual conflict policy applies per tab (clean reloads in place,
      // dirty keeps the user's text and raises the banner). The active tab — what
      // the user is actually looking at — is refreshed first.
      //
      // We still do NOT re-list loaded tree dirs here: iterating every loaded dir
      // costs a readDir per dir AND turns an externally-deleted dir into a spurious
      // "tree may be stale" banner. The tree refreshes from live events.
      const ordered = conv.activeTab
        ? [conv.activeTab, ...conv.tabs.filter((p) => p !== conv.activeTab)]
        : conv.tabs;
      const paths = ordered.filter((p) => conv.buffers[p]);
      if (paths.length === 0) return;

      const res = await safeCmd(() => commands.statFiles(paths));
      if (res.status !== "ok") {
        // The cheap check failed (it shouldn't — it's one stat per path). Don't
        // silently skip the refresh and leave tabs stale: fall back to reading
        // them, which is what this pass exists to guarantee.
        console.error("[editor] statFiles failed, falling back to a full re-read:", res.error);
        for (const path of paths) await reloadTab(convId, path);
        return;
      }
      const stats = new Map(res.data.map((s) => [s.path, s]));
      for (const path of paths) {
        // Re-read the buffer each iteration: a reload above may have changed it,
        // and the tab could have been closed while we awaited.
        const b = get().byConv[convId]?.buffers[path];
        if (!b) continue;
        const stat = stats.get(path);
        // No stat for a path we asked about (shouldn't happen — the backend answers
        // one entry per path) is unknown, not unchanged → re-read.
        if (stat && !diskStampChanged(b.diskStamp, stat)) continue;
        await reloadTab(convId, path);
      }
    },

    reloadFromDisk: (convId, path) =>
      patchBuffer(convId, path, (b) => {
        if (b.diskContent === null) return b;
        return { ...b, content: b.diskContent, saved: b.diskContent, dirty: false, diskChanged: false, diskContent: null };
      }),

    keepLocal: (convId, path) =>
      patchBuffer(convId, path, (b) => ({ ...b, diskChanged: false, diskContent: null })),
  };
});

// ---- Selectors --------------------------------------------------------------

export const useEditorOpen = () => useEditorStore((s) => s.open);
export const useEditorLayout = () =>
  useEditorStore(
    useShallow((s) => ({
      open: s.open,
      terminalOpen: s.terminalOpen,
      gitOpen: s.gitOpen,
      orientation: s.orientation,
      gitOrientation: s.gitOrientation,
      editorFraction: s.editorFraction,
      terminalFraction: s.terminalFraction,
      gitStripFraction: s.gitStripFraction,
      gitConvFraction: s.gitConvFraction,
      gitStripLeftFraction: s.gitStripLeftFraction,
      gitHistFraction: s.gitHistFraction,
      treeWidth: s.treeWidth,
    })),
  );

/** A conversation's editor slice (tree + tabs + buffers), or undefined. */
export const useConvEditor = (convId: string | null) =>
  useEditorStore((s) => (convId ? s.byConv[convId] : undefined));
