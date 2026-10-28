import { describe, it, expect, vi, beforeEach } from "vitest";

// The launch's IPC: each step answers as the core would; the store must drive them in order,
// stop at a failure, retry from there, and end by filing the conversation under the server.
vi.mock("../../../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  const local = {
    repoPath: "/Users/me/proj",
    commit: "c".repeat(40),
    branch: "main",
    subject: "wip",
    origin: null,
    unpushed: 1,
    submodules: false,
    macName: "Mac",
    source: "h:/Users/me/proj",
  };
  return {
    events: { serverLaunchProgressEvent: { listen: vi.fn(() => Promise.resolve(() => {})) } },
    commands: {
      serverLaunchBegin: vi.fn(() => ok("launch-1")),
      serverLaunchCheck: vi.fn(() =>
        ok({ os: "Linux", user: "j", home: "/home/j", host: "box", git: "git version 2.25.1", align: null }),
      ),
      serverLaunchTransfer: vi.fn(() => ok({ local, clone: "/home/j/flightdeck/repos/proj", created: true, bundleBytes: 10 })),
      serverLaunchCopy: vi.fn(() =>
        ok({ staged: 0, unstaged: 1, copied: [], skipped: [], skippedMore: 0, bytes: 5, stage: "/s" }),
      ),
      serverLaunchWorktree: vi.fn(() =>
        ok({
          worktree: "/home/j/flightdeck/repos/proj/.claude/worktrees/main",
          cwd: "/home/j/flightdeck/repos/proj/.claude/worktrees/main",
          branch: "main",
          createdBranch: true,
        }),
      ),
      serverLaunchFinish: vi.fn(() =>
        ok({
          clone: "/home/j/flightdeck/repos/proj",
          worktree: "/home/j/flightdeck/repos/proj/.claude/worktrees/main",
          cwd: "/home/j/flightdeck/repos/proj/.claude/worktrees/main",
          branch: "main",
          header: "h",
        }),
      ),
      serverLaunchEnd: vi.fn(() => ok()),
      upsertRepo: vi.fn(() => ok()),
      upsertConversation: vi.fn(() => ok()),
      setConversationClaudeAccount: vi.fn(() => ok()),
      setActiveConversation: vi.fn(() => ok()),
      spawnSession: vi.fn(() => ok("session-1")),
      loadConversationHistory: vi.fn(() => ok({ items: [], context: { context_tokens: null } })),
      loadSessionHistory: vi.fn(() => ok([])),
      loadSessionContext: vi.fn(() => ok({ context_tokens: 0 })),
      loadSessionGoal: vi.fn(() => ok(null)),
      loadSessionUsage: vi.fn(() => ok(null)),
      machineReachability: vi.fn(() => ok({ reachable: true })),
      pathExists: vi.fn(() => Promise.resolve(true)),
      stopSession: vi.fn(() => ok()),
      deleteConversation: vi.fn(() => ok()),
      stopRemoteConversations: vi.fn(() => ok({ stopped: [], not_archived: [] })),
    },
  };
});

import { commands } from "../../../ipc/client";
import { ensureConversationSession, useConversationsStore } from "../../../store/conversationsStore";
import { launchLockFor } from "../../../store/launchLocks";
import { cancelServerLaunch, retryServerLaunch, startServerLaunch, useServerLaunchStore } from "./serverLaunchStore";

const conv = {
  id: "c1",
  name: "Fix the login",
  repoId: "r1",
  cwd: "/Users/me/proj",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: null,
  handle: null,
  liveCwd: null,
  bypassAllowed: false,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "default" as const,
  pendingReminder: null,
  cleanOutput: null,
  kind: "claude" as const,
  tosseTaskId: "t1",
  tosseTaskTitle: "Fix the login",
  tosseTaskStatus: "En cours",
  claudeAccountId: null,
  lastAccountSwitchAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useServerLaunchStore.setState({ byConv: {}, dismissed: {} });
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/Users/me/proj", addedAt: 1 }],
    conversations: [{ ...conv }],
    activeId: "c1",
    machines: [
      {
        id: "m1",
        label: "box",
        host: "box.example",
        port: 22,
        user: "j",
        identityFile: null,
        addedAt: 1,
        addresses: [],
        daemonMacId: null,
        daemonRelayUrl: null,
        daemonLabel: null,
        phoneProvisionedAt: null,
      },
    ],
  });
});

describe("server launch", () => {
  it("runs every step, then files the SAME conversation under the server folder and starts it there", async () => {
    await startServerLaunch("c1", "m1");
    const l = useServerLaunchStore.getState().byConv.c1;
    expect(l.done).toBe(true);
    expect(Object.values(l.steps).every((s) => s.status === "done")).toBe(true);
    const st = useConversationsStore.getState();
    const moved = st.conversations.find((c) => c.id === "c1")!;
    const repo = st.repos.find((r) => r.id === moved.repoId)!;
    expect(repo).toMatchObject({ path: "/home/j/flightdeck/repos/proj", machineId: "m1" });
    expect(moved.cwd).toBe("/home/j/flightdeck/repos/proj/.claude/worktrees/main");
    // Same title, same TOSSE task.
    expect(moved).toMatchObject({ name: "Fix the login", tosseTaskId: "t1" });
    expect(launchLockFor("c1")).toBeNull();
    expect(commands.spawnSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commands.spawnSession).mock.calls[0]).toContain("/home/j/flightdeck/repos/proj/.claude/worktrees/main");
    expect(commands.serverLaunchEnd).toHaveBeenCalledWith("launch-1", false);
  });

  it("stops at a failed step, refuses a spawn here meanwhile, and retries from that step", async () => {
    vi.mocked(commands.serverLaunchCopy).mockResolvedValueOnce({ status: "error", error: "the link stopped moving" });
    await startServerLaunch("c1", "m1");
    let l = useServerLaunchStore.getState().byConv.c1;
    expect(l.steps.copy).toMatchObject({ status: "failed", error: "the link stopped moving" });
    expect(l.steps.worktree.status).toBe("pending");
    expect(l.running).toBe(false);
    // Locked: a message sent now would start it on this Mac.
    await expect(ensureConversationSession("c1")).rejects.toThrow(/being moved to box/);
    expect(commands.spawnSession).not.toHaveBeenCalled();
    await retryServerLaunch("c1");
    l = useServerLaunchStore.getState().byConv.c1;
    expect(l.done).toBe(true);
    expect(commands.serverLaunchTransfer).toHaveBeenCalledTimes(1);
    expect(commands.serverLaunchCopy).toHaveBeenCalledTimes(2);
  });

  it("a cancelled run never writes into the launch that replaced it", async () => {
    // The first launch's transfer answers only after it was cancelled and a second started.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(commands.serverLaunchTransfer).mockImplementationOnce(async () => {
      await gate;
      return { status: "error", error: "Cancelled." };
    });
    const first = startServerLaunch("c1", "m1");
    await vi.waitFor(() => expect(useServerLaunchStore.getState().byConv.c1?.steps.transfer.status).toBe("running"));
    await cancelServerLaunch("c1");
    const second = startServerLaunch("c1", "m1");
    release();
    await Promise.all([first, second]);
    const l = useServerLaunchStore.getState().byConv.c1;
    expect(l.done).toBe(true);
    expect(Object.values(l.steps).every((s) => s.status === "done")).toBe(true);
  });

  it("removing the conversation mid-move ends the move and cleans up after it", async () => {
    vi.mocked(commands.serverLaunchCopy).mockResolvedValueOnce({ status: "error", error: "x" });
    await startServerLaunch("c1", "m1");
    useConversationsStore.getState().removeConversation("c1");
    await vi.waitFor(() => expect(commands.serverLaunchEnd).toHaveBeenCalledWith("launch-1", true));
    expect(useServerLaunchStore.getState().byConv.c1).toBeUndefined();
  });

  it("cancelling before the move removes what it made and leaves the conversation on this Mac", async () => {
    vi.mocked(commands.serverLaunchWorktree).mockResolvedValueOnce({ status: "error", error: "boom" });
    await startServerLaunch("c1", "m1");
    await cancelServerLaunch("c1");
    expect(commands.serverLaunchEnd).toHaveBeenCalledWith("launch-1", true);
    expect(useServerLaunchStore.getState().byConv.c1).toBeUndefined();
    expect(launchLockFor("c1")).toBeNull();
    const c = useConversationsStore.getState().conversations.find((x) => x.id === "c1")!;
    expect(c).toMatchObject({ repoId: "r1", cwd: "/Users/me/proj" });
  });
});
