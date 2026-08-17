import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the IPC surface (same approach as conversationsStore.test.ts) plus the
// two action modules the executor delegates to — the point of these tests is
// the executor's OWN logic (resolution, guards, serialization), not the send
// pipeline or the editor, which have their own tests.
vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      upsertConversation: vi.fn(() => ok()),
      setActiveConversation: vi.fn(() => ok()),
      generateConversationTitle: vi.fn(() => ok()),
      loadSessionHistory: vi.fn(() => ok([])),
      codexLoadHistory: vi.fn(() => ok([])),
      loadSessionContext: vi.fn(() => ok({ context_tokens: 0 })),
      loadSessionGoal: vi.fn(() => ok(null)),
      pathExists: vi.fn(() => Promise.resolve(true)),
      readDir: vi.fn(() => ok([])),
    },
  };
});

vi.mock("../ipc/useCommands", () => ({
  sendConversationMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock("../notifications/notify", () => ({
  notifyFromAgent: vi.fn(() => ({ banner: true, dock: true, sound: true })),
}));

const editorActions = {
  revealInEditor: vi.fn(),
  ensureConv: vi.fn(),
  setOpen: vi.fn(),
  setTerminalOpen: vi.fn(),
  setGitOpen: vi.fn(),
};
vi.mock("../features/editor/editorStore", () => ({
  useEditorStore: { getState: () => editorActions },
}));

import { commands } from "../ipc/client";
import { sendConversationMessage } from "../ipc/useCommands";
import { notifyFromAgent } from "../notifications/notify";
import { executeAppControlTool, type AppControlHelpers } from "./appControl";
import { useConversationsStore, type Conversation } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import type { Turn } from "../store/types";

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "Alpha",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 5,
  sessionId: null,
  handle: null,
  liveCwd: null,
  bypassAllowed: false,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "auto",
  pendingReminder: null,
  tosseTaskId: null,
  tosseTaskTitle: null,
  tosseTaskStatus: null,
  cleanOutput: null,
  kind: "claude",
  ...over,
});

function seed(...convs: Conversation[]) {
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
    conversations: convs,
    activeId: convs[0]?.id ?? null,
  });
}

let turnSeq = 0;

/** Append a hand-built final turn to a conversation's timeline. */
function pushTurn(convId: string, turn: Partial<Turn> & { role: Turn["role"] }) {
  useConversationStore.getState().ensureSession(convId);
  const s = useConversationStore.getState();
  const entry = s.sessions[convId];
  const id = `t${++turnSeq}`;
  const full: Turn = {
    id,
    status: "final",
    streamingText: "",
    streamingThinking: "",
    blocks: [],
    parentToolUseId: null,
    hasThinking: false,
    ...turn,
  };
  useConversationStore.setState({
    sessions: {
      ...s.sessions,
      [convId]: {
        ...entry,
        timeline: [...entry.timeline, { kind: "turn" as const, id }],
        turns: { ...entry.turns, [id]: full },
      },
    },
  });
}

const helpers = (tosseAvailable = true): AppControlHelpers & { views: string[] } => {
  const views: string[] = [];
  return { views, changeView: (v) => views.push(v), tosseAvailable };
};

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({ sessions: {} });
  seed(conv());
});

describe("appControl — caller & target resolution", () => {
  it("whoami identifies the calling session's conversation", async () => {
    seed(conv({ handle: "session-7", liveCwd: "/tmp/r1/wt" }));
    const out = (await executeAppControlTool("whoami", {}, "session-7", helpers())) as Record<
      string,
      unknown
    >;
    expect(out.conversation_id).toBe("c1");
    expect(out.cwd).toBe("/tmp/r1/wt"); // liveCwd wins over the spawn cwd
    expect((out.repository as { path: string }).path).toBe("/tmp/r1");
  });

  it("whoami with no matching session throws", async () => {
    await expect(executeAppControlTool("whoami", {}, "session-404", helpers())).rejects.toThrow(
      /no conversation/,
    );
  });

  it("an explicit unknown conversation_id names the discovery tool", async () => {
    await expect(
      executeAppControlTool("read_conversation", { conversation_id: "nope" }, null, helpers()),
    ).rejects.toThrow(/list_conversations/);
  });

  it("an unknown tool is surfaced as a wiring error, never swallowed", async () => {
    await expect(executeAppControlTool("frobnicate", {}, null, helpers())).rejects.toThrow(
      /unknown app-control tool/,
    );
  });
});

describe("appControl — conversations", () => {
  it("list_conversations reports repo, status and flags the caller", async () => {
    seed(conv({ handle: "session-7" }), conv({ id: "c2", name: "Beta", handle: null }));
    const out = (await executeAppControlTool(
      "list_conversations",
      {},
      "session-7",
      helpers(),
    )) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    expect(out[0].is_caller).toBe(true);
    expect(out[1].is_caller).toBeUndefined();
    // c1 is live with nothing pending → idle; c2 has no process → off.
    expect((out[0].status as { kind: string }).kind).toBe("idle");
    expect((out[1].status as { kind: string }).kind).toBe("off");
    expect((out[0].repository as { name: string }).name).toBe("r1");
  });

  it("read_conversation serializes the dialogue and skips sub-agent turns", async () => {
    pushTurn("c1", { role: "user", blocks: [{ type: "text", text: "fix the bug" }] });
    pushTurn("c1", {
      role: "assistant",
      blocks: [
        { type: "tool_use", id: "tu1", name: "Bash", input: {} },
        { type: "text", text: "Done — the bug is fixed." },
      ],
    });
    pushTurn("c1", {
      role: "assistant",
      parentToolUseId: "tu1", // a sub-agent side thread: internal work
      blocks: [{ type: "text", text: "internal sub-agent chatter" }],
    });
    const out = (await executeAppControlTool(
      "read_conversation",
      { conversation_id: "c1" },
      null,
      helpers(),
    )) as { turns: Array<{ role: string; text: string }> };
    expect(out.turns).toHaveLength(2);
    expect(out.turns[0]).toEqual({ role: "user", text: "fix the bug" });
    expect(out.turns[1].text).toContain("[tool: Bash]");
    expect(out.turns[1].text).toContain("bug is fixed");
    expect(JSON.stringify(out)).not.toContain("sub-agent chatter");
  });

  it("send_message refuses a conversation messaging itself", async () => {
    seed(conv({ handle: "session-7" }));
    await expect(
      executeAppControlTool(
        "send_message",
        { conversation_id: "c1", text: "hi" },
        "session-7",
        helpers(),
      ),
    ).rejects.toThrow(/cannot message itself/);
    expect(sendConversationMessage).not.toHaveBeenCalled();
  });

  it("send_message delivers to another conversation through the single send path", async () => {
    seed(conv({ handle: "session-7" }), conv({ id: "c2", name: "Beta" }));
    const out = (await executeAppControlTool(
      "send_message",
      { conversation_id: "c2", text: "go" },
      "session-7",
      helpers(),
    )) as Record<string, unknown>;
    // `queued` mirrors the composer's send exactly (false here: c2 is idle).
    expect(sendConversationMessage).toHaveBeenCalledWith("c2", { text: "go", queued: false });
    expect(out.delivered).toBe(true);
  });

  it("create_conversation validates the folder, then creates + titles + sends", async () => {
    vi.mocked(commands.readDir).mockResolvedValueOnce({ status: "error", error: "x" } as never);
    await expect(
      executeAppControlTool("create_conversation", { repo_path: "/nope" }, null, helpers()),
    ).rejects.toThrow(/not an existing folder/);

    const out = (await executeAppControlTool(
      "create_conversation",
      { repo_path: "/tmp/r1", title: "Probe", first_message: "start" },
      null,
      helpers(),
    )) as Record<string, unknown>;
    const created = useConversationsStore
      .getState()
      .conversations.find((c) => c.id === out.conversation_id);
    expect(created?.name).toBe("Probe");
    expect(sendConversationMessage).toHaveBeenCalledWith(out.conversation_id, { text: "start" });
    expect(out.started).toBe(true);
  });

  it("create_conversation normalizes the path and never steals the selection", async () => {
    // The user is looking at c1; a trailing-slash spelling of the SAME repo must
    // not duplicate the group, and creating must not switch the active conv.
    const out = (await executeAppControlTool(
      "create_conversation",
      { repo_path: "/tmp/r1/" },
      null,
      helpers(),
    )) as Record<string, unknown>;
    expect(out.repo_path).toBe("/tmp/r1");
    const repos = useConversationsStore.getState().repos;
    expect(repos).toHaveLength(1); // no duplicate group from '/tmp/r1/'
    expect(useConversationsStore.getState().activeId).toBe("c1"); // selection kept
  });

  it("rename_conversation defaults to the calling conversation", async () => {
    seed(conv({ handle: "session-7" }));
    await executeAppControlTool("rename_conversation", { name: "Renamed" }, "session-7", helpers());
    expect(useConversationsStore.getState().conversations[0].name).toBe("Renamed");
  });
});

describe("appControl — UI actions", () => {
  it("focus_conversation selects and switches to the conversation view", async () => {
    seed(conv(), conv({ id: "c2", name: "Beta" }));
    const h = helpers();
    await executeAppControlTool("focus_conversation", { conversation_id: "c2" }, null, h);
    expect(useConversationsStore.getState().activeId).toBe("c2");
    expect(h.views).toEqual(["conversation"]);
  });

  it("open_file focuses the conversation and reveals via the editor's own entry point", async () => {
    seed(conv({ handle: "session-7" }));
    const h = helpers();
    const out = (await executeAppControlTool(
      "open_file",
      { path: "src/main.rs", line: 42 },
      "session-7",
      h,
    )) as Record<string, unknown>;
    expect(h.views).toEqual(["conversation"]);
    expect(editorActions.revealInEditor).toHaveBeenCalledWith(
      "c1",
      "/tmp/r1",
      "/tmp/r1/src/main.rs", // relative paths resolve against the conversation's cwd
      { line: 42, column: undefined },
    );
    expect(out.path).toBe("/tmp/r1/src/main.rs");
  });

  it("open_view refuses the TOSSE view when it is unavailable, instead of a silent no-op", async () => {
    const h = helpers(false);
    await expect(executeAppControlTool("open_view", { view: "tosse" }, null, h)).rejects.toThrow(
      /unavailable/,
    );
    expect(h.views).toEqual([]);
  });

  it("open_file refuses '~' paths and nonexistent files", async () => {
    seed(conv({ handle: "session-7" }));
    await expect(
      executeAppControlTool("open_file", { path: "~/notes.md" }, "session-7", helpers()),
    ).rejects.toThrow(/absolute path/);
    vi.mocked(commands.pathExists).mockResolvedValueOnce(false);
    await expect(
      executeAppControlTool("open_file", { path: "gone.rs" }, "session-7", helpers()),
    ).rejects.toThrow(/does not exist/);
    expect(editorActions.revealInEditor).not.toHaveBeenCalled();
  });

  it("open_view validates and delegates; open_panel drives the panels", async () => {
    const h = helpers();
    await expect(executeAppControlTool("open_view", { view: "settings" }, null, h)).rejects.toThrow(
      /view/,
    );
    await executeAppControlTool("open_view", { view: "flightdeck" }, null, h);
    expect(h.views).toEqual(["flightdeck"]);

    await executeAppControlTool("open_panel", { panel: "terminal", conversation_id: "c1" }, null, h);
    expect(editorActions.setTerminalOpen).toHaveBeenCalledWith(true);
    await executeAppControlTool("open_panel", { panel: "none", conversation_id: "c1" }, null, h);
    expect(editorActions.setOpen).toHaveBeenCalledWith(false);
    expect(editorActions.setGitOpen).toHaveBeenCalledWith(false);
  });

  it("notify_user forwards to the agent-notification path", async () => {
    await executeAppControlTool("notify_user", { message: "look here", critical: true }, null, helpers());
    expect(notifyFromAgent).toHaveBeenCalledWith("look here", true);
  });
});
