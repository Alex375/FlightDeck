import { beforeEach, describe, expect, it } from "vitest";
import {
  dockedConversation,
  editorKeyFor,
  isOutsideWorkspace,
  neighbourAfterClose,
  normalizeFolder,
  splitConversationTabs,
  useIdeStore,
  workspaceConversations,
  workspaceLabel,
  workspaceRepoId,
} from "./ideStore";
import { ideBlockedReason, openInIdeBlockedReason } from "./openInIde";

const REPO = { id: "r1", path: "/code/app" };
const OTHER = { id: "r2", path: "/code/other" };

const conv = (id: string, over: Partial<{ repoId: string; cwd: string; liveCwd: string | null }> = {}) => ({
  id,
  repoId: "r1",
  cwd: "/code/app",
  liveCwd: null,
  ...over,
});

describe("folder identity", () => {
  it("treats a trailing slash as the same folder, and leaves the root alone", () => {
    expect(normalizeFolder("/code/app/")).toBe("/code/app");
    expect(normalizeFolder("/code/app///")).toBe("/code/app");
    expect(normalizeFolder("/")).toBe("/");
  });

  it("labels a workspace with the folder's own name", () => {
    expect(workspaceLabel("/code/app/")).toBe("app");
    expect(workspaceLabel("/code/app/.claude/worktrees/ide-view")).toBe("ide-view");
  });

  it("keys the editor slice so it can never collide with a conversation id", () => {
    expect(editorKeyFor("abc")).toBe("ide:abc");
  });
});

describe("which tab takes over after a close", () => {
  it("keeps the active tab when another one closes", () => {
    expect(neighbourAfterClose(["a", "b", "c"], "a", "c")).toBe("c");
  });

  it("moves to the right-hand neighbour, else the left-hand one", () => {
    expect(neighbourAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
    expect(neighbourAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
  });

  it("ends on nothing when the last tab closes", () => {
    expect(neighbourAfterClose(["a"], "a", "a")).toBeNull();
  });
});

describe("a workspace's repository", () => {
  it("is the one it was opened from", () => {
    expect(workspaceRepoId({ path: "/code/app/.claude/worktrees/x", repoId: "r1" }, [REPO, OTHER])).toBe("r1");
  });

  it("falls back to the repository whose folder it IS — a stale id must not orphan it", () => {
    expect(workspaceRepoId({ path: "/code/app", repoId: null }, [REPO, OTHER])).toBe("r1");
    expect(workspaceRepoId({ path: "/code/app", repoId: "gone" }, [REPO, OTHER])).toBe("r1");
  });

  it("is null for a folder Flight Deck has no repository for", () => {
    expect(workspaceRepoId({ path: "/tmp/scratch", repoId: null }, [REPO])).toBeNull();
  });
});

describe("the conversations a workspace docks", () => {
  const all = [
    conv("root"),
    conv("in-worktree", { cwd: "/code/app/.claude/worktrees/x" }),
    conv("moved", { liveCwd: "/code/app/.claude/worktrees/x" }),
    conv("elsewhere", { repoId: "r2", cwd: "/code/other" }),
  ];

  const WORKTREE = "/code/app/.claude/worktrees/x";
  const at = (path: string, repoId: string | null, lastConvId: string | null = null) => ({
    path,
    repoId,
    lastConvId,
  });

  it("lists every conversation of the repository when its own folder is open", () => {
    const ids = workspaceConversations(at("/code/app", "r1"), all, [REPO, OTHER]).map((c) => c.id);
    expect(ids).toEqual(["root", "in-worktree", "moved"]);
  });

  it("lists only the agents working INSIDE a worktree opened on its own", () => {
    // The live cwd wins over the spawn cwd: an agent that MOVED into the worktree belongs
    // there, and the one still at the root edits files this workspace does not show.
    const ids = workspaceConversations(at(WORKTREE, "r1"), all, [REPO, OTHER]).map((c) => c.id);
    expect(ids).toEqual(["in-worktree", "moved"]);
  });

  it("keeps the DOCKED conversation listed when its agent walks out of the folder", () => {
    // What `/land` does to every agent of this repo's workflow: `ExitWorktree` resets the
    // live cwd to the repository root mid-run. The tab used to vanish under the user —
    // offered by neither the strip nor the closed-tabs menu, its attention pips dark.
    const landed = [conv("agent", { cwd: "/code/app", liveCwd: "/code/app" })];
    const ws = at(WORKTREE, "r1", "agent");
    expect(workspaceConversations(ws, landed, [REPO]).map((c) => c.id)).toEqual(["agent"]);
    expect(isOutsideWorkspace(ws, landed[0])).toBe(true);
    // Only the docked one is pinned — being outside is otherwise still a reason to go.
    expect(workspaceConversations(at(WORKTREE, "r1", "someone-else"), landed, [REPO])).toEqual([]);
    // …and the pin never reaches across repositories.
    expect(workspaceConversations(at(WORKTREE, "r2", "agent"), landed, [REPO, OTHER])).toEqual([]);
  });

  it("does not match a sibling folder that merely shares a prefix", () => {
    const sibling = [conv("sib", { cwd: "/code/app-v2" })];
    expect(workspaceConversations(at("/code/app", "r1"), sibling, [REPO])).toEqual([]);
  });

  it("lists nothing for a plain folder", () => {
    expect(workspaceConversations(at("/tmp/scratch", null), all, [REPO])).toEqual([]);
  });
});

describe("which conversation the dock shows", () => {
  const tabs = [
    { id: "a", lastActivityAt: 10 },
    { id: "b", lastActivityAt: 30 },
    { id: "c", lastActivityAt: 20 },
  ];

  it("follows the app's active conversation when it is one of the folder's tabs", () => {
    expect(dockedConversation(tabs, "c", "a")?.id).toBe("c");
  });

  it("falls back to the workspace's own last one, then its most recent — WITHOUT selecting it", () => {
    // The active conversation belongs to another folder: the dock shows ITS conversation,
    // and the function is pure — nothing here can repoint the app's selection, which is
    // the whole fix (a visit to the IDE view used to do exactly that).
    expect(dockedConversation(tabs, "other-repo-conv", "a")?.id).toBe("a");
    expect(dockedConversation(tabs, "other-repo-conv", "closed-or-gone")?.id).toBe("b");
    expect(dockedConversation(tabs, null, null)?.id).toBe("b");
  });

  it("shows nothing when the folder has no open tab", () => {
    expect(dockedConversation([], "a", "a")).toBeNull();
  });

  it("lists closed tabs in CLOSE order, so 'reopen the last closed' means it", () => {
    const convs = [{ id: "old" }, { id: "mid" }, { id: "new" }];
    // Closed newest-first, then the oldest: the last one closed is "old".
    const { closed, open } = splitConversationTabs(convs, ["new", "gone-conversation", "old"]);
    expect(closed.map((c) => c.id)).toEqual(["new", "old"]);
    expect(open.map((c) => c.id)).toEqual(["mid"]);
  });
});

describe("refusing to open", () => {
  it("refuses a remote repository, with a reason a button can show", () => {
    expect(ideBlockedReason({ machineId: "m1" })).toMatch(/remote server/);
    expect(ideBlockedReason({ machineId: null })).toBeNull();
    expect(ideBlockedReason(null)).toBeNull();
  });

  it("reports the switched-off view before anything else", () => {
    expect(openInIdeBlockedReason({ machineId: "m1" }, false)).toMatch(/switched off/);
    expect(openInIdeBlockedReason(null, true)).toBeNull();
  });
});

describe("the store", () => {
  beforeEach(() => {
    useIdeStore.setState({ workspaces: [], activeId: null, dockMaximized: false });
  });

  it("opens a folder once: a second open focuses the same workspace", () => {
    const a = useIdeStore.getState().openWorkspace("/code/app", "r1");
    useIdeStore.getState().openWorkspace("/code/other", "r2");
    const again = useIdeStore.getState().openWorkspace("/code/app/");
    expect(again).toBe(a);
    expect(useIdeStore.getState().workspaces).toHaveLength(2);
    expect(useIdeStore.getState().activeId).toBe(a);
  });

  it("lets a folder opened bare learn its repository later", () => {
    const id = useIdeStore.getState().openWorkspace("/code/app");
    useIdeStore.getState().openWorkspace("/code/app", "r1");
    expect(useIdeStore.getState().workspaces.find((w) => w.id === id)?.repoId).toBe("r1");
  });

  it("numbers terminals monotonically and hands focus to a neighbour on close", () => {
    const ws = useIdeStore.getState().openWorkspace("/code/app", "r1");
    const t1 = useIdeStore.getState().addTerminal(ws)!;
    const t2 = useIdeStore.getState().addTerminal(ws)!;
    useIdeStore.getState().closeTerminal(ws, t2);
    const t3 = useIdeStore.getState().addTerminal(ws)!;
    const state = useIdeStore.getState().workspaces.find((w) => w.id === ws)!;
    // "Terminal 2" is gone for good: reissuing it would name two different shells alike
    // within one session.
    expect(state.terminals.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 3"]);
    expect(state.activeTerminalId).toBe(t3);
    expect(new Set([t1, t2, t3]).size).toBe(3);

    useIdeStore.getState().closeTerminal(ws, t3);
    expect(useIdeStore.getState().workspaces.find((w) => w.id === ws)!.activeTerminalId).toBe(t1);
  });

  it("ignores a blank rename", () => {
    const ws = useIdeStore.getState().openWorkspace("/code/app", "r1");
    const t = useIdeStore.getState().addTerminal(ws)!;
    useIdeStore.getState().renameTerminal(ws, t, "   ");
    useIdeStore.getState().renameTerminal(ws, t, " dev server ");
    expect(useIdeStore.getState().workspaces[0].terminals[0].title).toBe("dev server");
  });

  it("clamps the layout to the bounds it persists", () => {
    useIdeStore.getState().setDockFraction(0.99);
    expect(useIdeStore.getState().dockFraction).toBe(0.8);
    useIdeStore.getState().setTreeWidth(10);
    expect(useIdeStore.getState().treeWidth).toBe(160);
  });

  it("showing a dock mode opens a closed dock, and closing it drops the maximize", () => {
    useIdeStore.getState().setDockOpen(false);
    useIdeStore.getState().showDock("terminals");
    expect(useIdeStore.getState().dockOpen).toBe(true);
    expect(useIdeStore.getState().dockMode).toBe("terminals");
    useIdeStore.getState().setDockMaximized(true);
    useIdeStore.getState().setDockOpen(false);
    // A maximized-but-closed dock would come back hiding the editor with no visible cause.
    expect(useIdeStore.getState().dockMaximized).toBe(false);
  });

  it("closes a conversation TAB without touching the conversation, and reopens it", () => {
    const ws = useIdeStore.getState().openWorkspace("/code/app", "r1");
    const tabs = () => useIdeStore.getState().workspaces.find((w) => w.id === ws)!.closedConvIds;
    useIdeStore.getState().closeConversationTab(ws, "c1");
    useIdeStore.getState().closeConversationTab(ws, "c1"); // closing twice is one close
    useIdeStore.getState().closeConversationTab(ws, "c2");
    expect(tabs()).toEqual(["c1", "c2"]);

    const convs = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];
    const { open, closed } = splitConversationTabs(convs, tabs());
    // A conversation nobody closed is a tab by default — including one created later.
    expect(open.map((c) => c.id)).toEqual(["c3"]);
    expect(closed.map((c) => c.id)).toEqual(["c1", "c2"]);

    useIdeStore.getState().reopenConversationTab(ws, "c1");
    useIdeStore.getState().reopenConversationTab(ws, "never-closed"); // no-op
    expect(tabs()).toEqual(["c2"]);
  });

  it("closes a workspace and lands on its neighbour", async () => {
    const a = useIdeStore.getState().openWorkspace("/code/app", "r1");
    const b = useIdeStore.getState().openWorkspace("/code/other", "r2");
    expect(await useIdeStore.getState().closeWorkspace(b)).toBe(true);
    expect(useIdeStore.getState().workspaces.map((w) => w.id)).toEqual([a]);
    expect(useIdeStore.getState().activeId).toBe(a);
  });
});
