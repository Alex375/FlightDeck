// State for the top-level IDE view: which folders are open as WORKSPACES, which one is
// on screen, and how the view is laid out (explorer width, the bottom dock's size, mode
// and position).
//
// A workspace is a FOLDER, not a conversation — that is the whole difference with the
// conversation view's side panel, whose editor follows one conversation's cwd. Everything
// the workspace shows is built on the services that already exist, keyed by ids this
// module mints:
//   • its editor (tree + tabs + buffers) is a slice of the editor store, under
//     `editorKeyFor(ws.id)` — the store never cared that its keys were conversation ids;
//   • its terminals are `termManager` entries under `ide:<ws>:<uid>` — same story for the
//     PTY service, which is keyed by an opaque string;
//   • its conversations are NOT copied here: the dock lists the live conversations of the
//     workspace's repository. The one on screen FOLLOWS the app's active conversation when
//     that one belongs to the folder (so a tab click, a fork, ⌘⌥↑/↓ and the conversation
//     view stay in step for free) and otherwise falls back to the workspace's own last
//     one — displayed only, never selected: see `dockedConversation`.
//
// Persistence mirrors the other layout stores (localStorage, best-effort): the workspace
// list and the layout survive a restart; terminals do not (their shells died with the app).

import { create } from "zustand";
import { uid } from "../../util/id";
import { disposeTerminal } from "../terminal/cleanup";
import { useEditorStore } from "../editor/editorStore";

const STORAGE_KEY = "tosse:ide";

/** What the dock shows: the workspace's shells, or its agent conversations. */
export type DockMode = "terminals" | "conversations";
/** Where the dock sits relative to the editor: under it (a classic IDE panel) or beside it. */
export type DockPosition = "bottom" | "right";

export interface IdeTerminal {
  /** The `termManager` / PTY id. Globally unique — see `newTerminalId`. */
  id: string;
  title: string;
}

export interface IdeWorkspace {
  id: string;
  /** Absolute folder path, normalized (no trailing slash). The workspace's identity. */
  path: string;
  /** The repository this folder belongs to, when it was opened from one. A worktree
   *  workspace keeps its PARENT repo's id, which is how it finds its conversations. Null
   *  for a plain folder — resolved by path at read time (see `workspaceRepoId`). */
  repoId: string | null;
  /** The conversation this workspace's dock last showed, so coming back to a folder
   *  returns to ITS conversation rather than to whichever was most recent. */
  lastConvId: string | null;
  /** Conversations whose TAB the user closed in this workspace's dock. Closing a tab is
   *  NOT deleting: the conversation lives on (sidebar, Flight Deck) and can be reopened
   *  from the dock. Stored as the closed set rather than the open one so a conversation
   *  created anywhere in the folder shows up as a tab without anyone having to add it. */
  closedConvIds: string[];
  /** In-memory only: shells do not survive the app. */
  terminals: IdeTerminal[];
  activeTerminalId: string | null;
  /** Monotonic, so a closed "Terminal 2" is never reissued while "Terminal 3" lives. */
  termSeq: number;
}

export const DOCK_FRACTION_MIN = 0.15;
export const DOCK_FRACTION_MAX = 0.8;
export const TREE_WIDTH_MIN = 160;
export const TREE_WIDTH_MAX = 600;

interface Layout {
  treeWidth: number;
  treeCollapsed: boolean;
  dockOpen: boolean;
  dockMode: DockMode;
  dockPosition: DockPosition;
  /** Share of the editor column (bottom) or row (right) the dock takes, 0..1. */
  dockFraction: number;
}

const DEFAULT_LAYOUT: Layout = {
  treeWidth: 250,
  treeCollapsed: false,
  dockOpen: true,
  dockMode: "conversations",
  dockPosition: "bottom",
  dockFraction: 0.38,
};

// ---- Pure helpers (unit-tested) ----------------------------------------------------

export function clampNum(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** One spelling per folder, so "/a/b" and "/a/b/" are the same workspace. The root "/"
 *  is left alone. */
export function normalizeFolder(path: string): string {
  const t = path.trim();
  return t.length > 1 ? t.replace(/\/+$/, "") : t;
}

/** The label a workspace wears on its tab: the folder's own name. */
export function workspaceLabel(path: string): string {
  const parts = normalizeFolder(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The editor-store key of a workspace's slice. Prefixed so it can never collide with a
 *  conversation id (a uuid) sharing the same store. */
export function editorKeyFor(workspaceId: string): string {
  return `ide:${workspaceId}`;
}

/** A fresh terminal id. RANDOM rather than sequential: the PTY service outlives a webview
 *  reload, so a replayed `ide:<ws>:1` could attach to a shell the previous page left
 *  running. */
function newTerminalId(workspaceId: string): string {
  return `ide:${workspaceId}:${uid()}`;
}

/** Which item takes over when `closedId` leaves `ids`: the neighbour on the right, else
 *  the one on the left — the tab that slides under the pointer, as in every tab bar. */
export function neighbourAfterClose(ids: string[], closedId: string, activeId: string | null): string | null {
  if (activeId !== closedId) return activeId;
  const idx = ids.indexOf(closedId);
  const rest = ids.filter((id) => id !== closedId);
  if (idx < 0) return rest[0] ?? null;
  return rest[idx] ?? rest[idx - 1] ?? null;
}

interface RepoLike {
  id: string;
  path: string;
}
interface ConvLike {
  id: string;
  repoId: string;
  cwd: string;
  liveCwd: string | null;
}

/** The repository a workspace belongs to: the one it was opened from, else the one whose
 *  folder it IS. Null for a folder Flight Deck has no repository for (yet). */
export function workspaceRepoId(ws: Pick<IdeWorkspace, "path" | "repoId">, repos: RepoLike[]): string | null {
  if (ws.repoId && repos.some((r) => r.id === ws.repoId)) return ws.repoId;
  return repos.find((r) => normalizeFolder(r.path) === ws.path)?.id ?? null;
}

function within(ancestor: string, child: string): boolean {
  return child === ancestor || child.startsWith(ancestor + "/");
}

/**
 * The conversations a workspace's dock lists: those of its repository that work INSIDE the
 * open folder. For the repository's own folder that is all of them (worktrees live under
 * it); for a worktree opened on its own, only the agents working in that worktree — the
 * others edit files this workspace does not even show.
 *
 * ⚠️ Plus ONE pinned exception: the conversation the dock is showing (`lastConvId`) stays
 * listed even when its agent moves OUT of the folder. That is not an edge case — it is
 * what `/land` does to every agent of this repo's own workflow (`ExitWorktree` resets its
 * cwd to the repository root mid-run). Without the pin the tab vanished under the user,
 * was offered by neither the strip nor the "closed tabs" menu, and its attention pips went
 * dark on the very surface being watched. See `isOutsideWorkspace` for how it is marked.
 */
export function workspaceConversations<C extends ConvLike>(
  ws: Pick<IdeWorkspace, "path" | "repoId" | "lastConvId">,
  conversations: C[],
  repos: RepoLike[],
): C[] {
  const repoId = workspaceRepoId(ws, repos);
  if (!repoId) return [];
  return conversations.filter(
    (c) => c.repoId === repoId && (c.id === ws.lastConvId || !isOutsideWorkspace(ws, c)),
  );
}

/** Whether a conversation currently works outside the workspace's folder — true only for
 *  the pinned one (see `workspaceConversations`), whose tab says so rather than looking
 *  like any other. */
export function isOutsideWorkspace(ws: Pick<IdeWorkspace, "path">, c: Pick<ConvLike, "cwd" | "liveCwd">): boolean {
  return !within(ws.path, normalizeFolder(c.liveCwd ?? c.cwd));
}

/** Split a workspace's conversations into the tabs on show and the ones whose tab was
 *  closed (offered for reopening). `open` keeps the given order; `closed` follows the
 *  CLOSE order (oldest close first), so "reopen the last closed tab" means what it says. */
export function splitConversationTabs<C extends { id: string }>(
  convs: C[],
  closedConvIds: readonly string[],
): { open: C[]; closed: C[] } {
  const closedSet = new Set(closedConvIds);
  const byId = new Map(convs.map((c) => [c.id, c]));
  return {
    open: convs.filter((c) => !closedSet.has(c.id)),
    closed: closedConvIds.map((id) => byId.get(id)).filter((c): c is C => c !== undefined),
  };
}

/**
 * The conversation a workspace's dock shows: the app's ACTIVE conversation when it is one
 * of this workspace's open tabs, else the workspace's OWN last one (then its most recent).
 *
 * ⚠️ The fallback is only DISPLAYED — nothing here selects it. Walking into the IDE view
 * (or onto another folder's tab) is navigation, and navigation must not repoint the app's
 * active conversation: it used to, which lost the user's place in the conversation view
 * and moved the notification gate onto a conversation they never picked. The global
 * selection now changes on explicit picks only (a tab click, "+", reopen, "Open in IDE").
 * A conversation shown without being active is nothing new — the Flight Deck reply modal
 * has always done it.
 */
export function dockedConversation<C extends { id: string; lastActivityAt: number }>(
  openTabs: C[],
  activeId: string | null,
  lastConvId: string | null,
): C | null {
  if (openTabs.length === 0) return null;
  return (
    openTabs.find((c) => c.id === activeId) ??
    openTabs.find((c) => c.id === lastConvId) ??
    [...openTabs].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  );
}

// ---- Persistence -------------------------------------------------------------------

type PersistedWorkspace = Pick<IdeWorkspace, "id" | "path" | "repoId" | "lastConvId" | "closedConvIds">;

interface Persisted {
  workspaces: PersistedWorkspace[];
  activeId: string | null;
  layout: Layout;
}

function hydrate(w: PersistedWorkspace): IdeWorkspace {
  return { ...w, terminals: [], activeTerminalId: null, termSeq: 0 };
}

function load(): Persisted {
  const empty: Persisted = { workspaces: [], activeId: null, layout: DEFAULT_LAYOUT };
  if (typeof localStorage === "undefined") return empty;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Persisted>;
    const seen = new Set<string>();
    const workspaces: Persisted["workspaces"] = [];
    for (const w of Array.isArray(p.workspaces) ? p.workspaces : []) {
      if (!w || typeof w.id !== "string" || typeof w.path !== "string" || !w.path) continue;
      const path = normalizeFolder(w.path);
      if (seen.has(path)) continue;
      seen.add(path);
      workspaces.push({
        id: w.id,
        path,
        repoId: typeof w.repoId === "string" ? w.repoId : null,
        lastConvId: typeof w.lastConvId === "string" ? w.lastConvId : null,
        closedConvIds: Array.isArray(w.closedConvIds)
          ? w.closedConvIds.filter((x): x is string => typeof x === "string")
          : [],
      });
    }
    const l = (p.layout ?? {}) as Partial<Layout>;
    const layout: Layout = {
      // Clamp bounds MUST match the setters below, else a saved size jumps on reload.
      treeWidth:
        typeof l.treeWidth === "number"
          ? clampNum(l.treeWidth, TREE_WIDTH_MIN, TREE_WIDTH_MAX)
          : DEFAULT_LAYOUT.treeWidth,
      treeCollapsed: typeof l.treeCollapsed === "boolean" ? l.treeCollapsed : DEFAULT_LAYOUT.treeCollapsed,
      dockOpen: typeof l.dockOpen === "boolean" ? l.dockOpen : DEFAULT_LAYOUT.dockOpen,
      dockMode: l.dockMode === "terminals" ? "terminals" : "conversations",
      dockPosition: l.dockPosition === "right" ? "right" : "bottom",
      dockFraction:
        typeof l.dockFraction === "number"
          ? clampNum(l.dockFraction, DOCK_FRACTION_MIN, DOCK_FRACTION_MAX)
          : DEFAULT_LAYOUT.dockFraction,
    };
    const activeId =
      typeof p.activeId === "string" && workspaces.some((w) => w.id === p.activeId)
        ? p.activeId
        : (workspaces[0]?.id ?? null);
    return { workspaces, activeId, layout };
  } catch {
    return empty;
  }
}

function save(s: IdeState): void {
  if (typeof localStorage === "undefined") return;
  const data: Persisted = {
    workspaces: s.workspaces.map((w) => ({
      id: w.id,
      path: w.path,
      repoId: w.repoId,
      lastConvId: w.lastConvId,
      closedConvIds: w.closedConvIds,
    })),
    activeId: s.activeId,
    layout: {
      treeWidth: s.treeWidth,
      treeCollapsed: s.treeCollapsed,
      dockOpen: s.dockOpen,
      dockMode: s.dockMode,
      dockPosition: s.dockPosition,
      dockFraction: s.dockFraction,
    },
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota / disabled storage — best-effort, matches the other layout stores */
  }
}

// ---- Store -------------------------------------------------------------------------

interface IdeState extends Layout {
  workspaces: IdeWorkspace[];
  activeId: string | null;
  /** The dock fills the whole editor area (VS Code's "maximize panel"). Transient. */
  dockMaximized: boolean;
  /** The conversation the dock has ON SCREEN right now, or null (IDE view not shown, dock
   *  closed, Terminals mode, nothing docked). Transient, set by the dock itself. It may
   *  differ from the app's active conversation (see `dockedConversation`), which is why
   *  the notification gate reads it as a second "the user is watching this" surface —
   *  exactly as it does for the Flight Deck reply modal. */
  watchedConvId: string | null;
  /** Bumped by `show()`: "put the IDE view on screen". App owns the view switch, so a
   *  deep caller (a sidebar button, the composer) asks through here — the same shape as
   *  the thread-jump request. */
  showNonce: number;

  /** Open `path` as a workspace (or focus the one already open on it). Returns its id. */
  openWorkspace: (path: string, repoId?: string | null) => string;
  /** Close a workspace: saves its unsaved files, kills its shells, forgets its editor
   *  state. Resolves false — workspace KEPT — when a file could not be saved. */
  closeWorkspace: (id: string) => Promise<boolean>;
  setActive: (id: string) => void;
  show: () => void;
  /** Remember the conversation a workspace's dock is showing (see `lastConvId`). */
  noteConversation: (workspaceId: string, convId: string) => void;
  /** Close a conversation's TAB in a workspace's dock. The conversation itself is left
   *  alone — see `closedConvIds`. Picking what to show next is the dock's job: it knows
   *  the tab order on screen. */
  closeConversationTab: (workspaceId: string, convId: string) => void;
  /** Bring a closed conversation tab back. No-op when it was not closed. */
  reopenConversationTab: (workspaceId: string, convId: string) => void;

  addTerminal: (workspaceId: string) => string | null;
  closeTerminal: (workspaceId: string, terminalId: string) => void;
  setActiveTerminal: (workspaceId: string, terminalId: string) => void;
  renameTerminal: (workspaceId: string, terminalId: string, title: string) => void;

  setTreeWidth: (w: number) => void;
  setTreeCollapsed: (collapsed: boolean) => void;
  setDockOpen: (open: boolean) => void;
  toggleDock: () => void;
  /** Show the dock on `mode` — opens it if it was closed. */
  showDock: (mode: DockMode) => void;
  setDockPosition: (p: DockPosition) => void;
  setDockFraction: (f: number) => void;
  setDockMaximized: (on: boolean) => void;
  setWatchedConv: (convId: string | null) => void;
}

export const useIdeStore = create<IdeState>()((set, get) => {
  const initial = load();

  /** Apply a patch, then persist. */
  function commit(patch: Partial<IdeState>): void {
    set(patch);
    save(get());
  }

  function patchWorkspace(id: string, fn: (w: IdeWorkspace) => IdeWorkspace): void {
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? fn(w) : w)) }));
  }

  return {
    ...initial.layout,
    workspaces: initial.workspaces.map(hydrate),
    activeId: initial.activeId,
    dockMaximized: false,
    watchedConvId: null,
    showNonce: 0,

    openWorkspace: (rawPath, repoId = null) => {
      const path = normalizeFolder(rawPath);
      const existing = get().workspaces.find((w) => w.path === path);
      if (existing) {
        // A folder first opened bare, then from its repository, learns whose it is.
        const workspaces =
          repoId && !existing.repoId
            ? get().workspaces.map((w) => (w.id === existing.id ? { ...w, repoId } : w))
            : get().workspaces;
        commit({ workspaces, activeId: existing.id });
        return existing.id;
      }
      const ws = hydrate({ id: uid(), path, repoId, lastConvId: null, closedConvIds: [] });
      commit({ workspaces: [...get().workspaces, ws], activeId: ws.id });
      return ws.id;
    },

    closeWorkspace: async (id) => {
      const ws = get().workspaces.find((w) => w.id === id);
      if (!ws) return true;
      // Editor first: it is the only step that can refuse (an unsaved file that will not
      // save). Nothing has been torn down yet at that point, so "kept open" is the truth.
      const dropped = await useEditorStore.getState().dropConv(editorKeyFor(id));
      if (!dropped) return false;
      for (const t of ws.terminals) disposeTerminal(t.id);
      const ids = get().workspaces.map((w) => w.id);
      commit({
        workspaces: get().workspaces.filter((w) => w.id !== id),
        activeId: neighbourAfterClose(ids, id, get().activeId),
      });
      return true;
    },

    setActive: (id) => {
      if (get().workspaces.some((w) => w.id === id)) commit({ activeId: id });
    },

    show: () => set((s) => ({ showNonce: s.showNonce + 1 })),

    noteConversation: (workspaceId, convId) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws || ws.lastConvId === convId) return;
      commit({
        workspaces: get().workspaces.map((w) => (w.id === workspaceId ? { ...w, lastConvId: convId } : w)),
      });
    },

    closeConversationTab: (workspaceId, convId) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws || ws.closedConvIds.includes(convId)) return;
      commit({
        workspaces: get().workspaces.map((w) =>
          w.id === workspaceId ? { ...w, closedConvIds: [...w.closedConvIds, convId] } : w,
        ),
      });
    },

    reopenConversationTab: (workspaceId, convId) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws || !ws.closedConvIds.includes(convId)) return;
      commit({
        workspaces: get().workspaces.map((w) =>
          w.id === workspaceId
            ? { ...w, closedConvIds: w.closedConvIds.filter((id) => id !== convId) }
            : w,
        ),
      });
    },

    addTerminal: (workspaceId) => {
      const ws = get().workspaces.find((w) => w.id === workspaceId);
      if (!ws) return null;
      const seq = ws.termSeq + 1;
      const term: IdeTerminal = { id: newTerminalId(workspaceId), title: `Terminal ${seq}` };
      patchWorkspace(workspaceId, (w) => ({
        ...w,
        terminals: [...w.terminals, term],
        activeTerminalId: term.id,
        termSeq: seq,
      }));
      return term.id;
    },

    closeTerminal: (workspaceId, terminalId) => {
      disposeTerminal(terminalId);
      patchWorkspace(workspaceId, (w) => ({
        ...w,
        terminals: w.terminals.filter((t) => t.id !== terminalId),
        activeTerminalId: neighbourAfterClose(
          w.terminals.map((t) => t.id),
          terminalId,
          w.activeTerminalId,
        ),
      }));
    },

    setActiveTerminal: (workspaceId, terminalId) =>
      patchWorkspace(workspaceId, (w) =>
        w.terminals.some((t) => t.id === terminalId) ? { ...w, activeTerminalId: terminalId } : w,
      ),

    renameTerminal: (workspaceId, terminalId, title) => {
      const clean = title.trim();
      if (!clean) return;
      patchWorkspace(workspaceId, (w) => ({
        ...w,
        terminals: w.terminals.map((t) => (t.id === terminalId ? { ...t, title: clean } : t)),
      }));
    },

    setTreeWidth: (w) => commit({ treeWidth: clampNum(w, TREE_WIDTH_MIN, TREE_WIDTH_MAX) }),
    setTreeCollapsed: (treeCollapsed) => commit({ treeCollapsed }),
    setDockOpen: (dockOpen) => commit({ dockOpen, dockMaximized: dockOpen ? get().dockMaximized : false }),
    toggleDock: () => get().setDockOpen(!get().dockOpen),
    showDock: (dockMode) => commit({ dockMode, dockOpen: true }),
    setDockPosition: (dockPosition) => commit({ dockPosition }),
    setDockFraction: (f) => commit({ dockFraction: clampNum(f, DOCK_FRACTION_MIN, DOCK_FRACTION_MAX) }),
    setDockMaximized: (dockMaximized) => set({ dockMaximized }),
    setWatchedConv: (watchedConvId) => {
      if (get().watchedConvId !== watchedConvId) set({ watchedConvId });
    },
  };
});

/** The workspace on screen, or null when none is open. */
export const useActiveWorkspace = (): IdeWorkspace | null =>
  useIdeStore((s) => s.workspaces.find((w) => w.id === s.activeId) ?? null);
