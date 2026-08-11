import { describe, it, expect, vi, beforeEach } from "vitest";

// A fork must CONTINUE the conversation it branched from — same model, same effort, same
// permission mode. Both fork paths (Claude = transcript copy re-imported through
// `reactivateDiskConversation`, Codex = native `thread/fork` through
// `materializeCodexBranch`) used to seed the product defaults instead, so branching a
// Sonnet conversation silently landed on Opus/xhigh, with nothing on screen saying so.

// Stub the IPC surface: forking persists the new row (upsertConversation) and re-selects
// it (setActiveConversation); the fork itself is a single command per backend.
vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      upsertConversation: vi.fn(() => ok()),
      setActiveConversation: vi.fn(() => ok()),
      forkConversation: vi.fn(() =>
        ok({
          conversation: {
            session_id: "forked-session",
            cwd: "/tmp/r1",
            repo_root: "/tmp/r1",
            git_branch: null,
            title: null,
            excerpt: "hi",
            mtime_ms: 100,
            backend: "claude",
          },
          removed_prompt: null,
        }),
      ),
      codexFork: vi.fn(() => ok({ threadId: "forked-thread", model: "gpt-5.6-sol" })),
    },
  };
});

import {
  forkConversation,
  materializeCodexBranch,
  reactivateDiskConversation,
  useConversationsStore,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_PERMISSION_MODE,
  type Conversation,
} from "./conversationsStore";

const sourceConv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "Source",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: "src-session",
  handle: null,
  liveCwd: null,
  bypassAllowed: false,
  // Deliberately NOT the product defaults — that is the whole point of the test.
  model: "sonnet",
  effort: "medium",
  ultracode: false,
  permissionMode: "plan",
  cleanOutput: true,
  pendingReminder: null,
  kind: "claude",
  tosseTaskId: null,
  tosseTaskTitle: null,
  tosseTaskStatus: null,
  ...over,
});

function seed(conv: Conversation) {
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
    conversations: [conv],
    activeId: conv.id,
  });
}

const convById = (id: string) =>
  useConversationsStore.getState().conversations.find((c) => c.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fork — the branch inherits the source conversation's controls", () => {
  it("a Claude fork keeps the source model / effort / permission mode / clean output", async () => {
    seed(sourceConv());
    const newId = await forkConversation("c1", "m-3", false, null, null);
    const branch = convById(newId!);
    // Without this, the next message would spawn `--resume` on Opus at xhigh: another
    // model and a much higher plan burn than the conversation the user branched from.
    expect(branch.model).toBe("sonnet");
    expect(branch.effort).toBe("medium");
    expect(branch.permissionMode).toBe("plan");
    expect(branch.cleanOutput).toBe(true);
    expect(branch.kind).toBe("claude");
    expect(branch.sessionId).toBe("forked-session"); // the copied transcript is its resume key
  });

  it("a Claude fork carries the ultracode tier over too", async () => {
    seed(sourceConv({ model: "opus", effort: "xhigh", ultracode: true }));
    const newId = await forkConversation("c1", "m-3", false, null, null);
    expect(convById(newId!).ultracode).toBe(true);
  });

  it("a Codex fork keeps the same controls (both paths agree)", async () => {
    seed(sourceConv({ kind: "codex", model: "gpt-5.5", effort: "ultra" }));
    const newId = await forkConversation("c1", "m-3", false, null, null);
    const branch = convById(newId!);
    // The forked thread's RESOLVED model wins over the source's (Codex reports it), but
    // every other control comes from the source, as on the Claude path.
    expect(branch.model).toBe("gpt-5.6-sol");
    expect(branch.effort).toBe("ultra");
    expect(branch.permissionMode).toBe("plan");
    expect(branch.cleanOutput).toBe(true);
    expect(branch.kind).toBe("codex");
  });

  it("a Codex branch never carries the Claude-only ultracode tier", () => {
    const source = sourceConv({ kind: "codex", ultracode: true });
    seed(source);
    const newId = materializeCodexBranch(source, "t-2", null, "branch");
    expect(convById(newId).ultracode).toBe(false);
  });

  it("the History panel still gets the product defaults — it has no source to copy", () => {
    useConversationsStore.setState({
      repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
      conversations: [],
      activeId: null,
    });
    const id = reactivateDiskConversation({
      session_id: "disk-1",
      cwd: "/tmp/r1",
      repo_root: "/tmp/r1",
      git_branch: null,
      title: null,
      excerpt: "hi",
      mtime_ms: 100,
      backend: "claude",
    });
    const conv = convById(id);
    expect(conv.model).toBe(DEFAULT_MODEL);
    expect(conv.effort).toBe(DEFAULT_EFFORT);
    expect(conv.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
    expect(conv.cleanOutput).toBeNull();
  });
});
