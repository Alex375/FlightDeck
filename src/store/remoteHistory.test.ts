// A conversation on a paired server opened with its stream off showed NOTHING: its history was
// read from this Mac's `~/.claude` (where it is not) and the empty answer was taken as "nothing
// to show". It is now read from the server's transcript; a failed read is said, and retried at
// the next open; a second caller waits for the same read instead of racing past it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const ok = <T>(data: T) => ({ status: "ok" as const, data });
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  const commands = new Proxy(fns, {
    get: (target, key: string) => (target[key] ??= vi.fn(async () => ok(null))),
  });
  return { ok, fns, commands };
});

vi.mock("../ipc/client", () => ({ commands: mocks.commands, events: {} }));

import type { ConversationItem } from "../ipc/client";
import { loadConversationHistory, useConversationsStore } from "./conversationsStore";
import { useConversationStore } from "./conversationStore";
import { useAppErrors } from "./appErrors";

const items: ConversationItem[] = [
  { kind: "user_message", id: "u1", text: "hello", parent_tool_use_id: null, replay: false } as ConversationItem,
  {
    kind: "assistant_message",
    id: "m1",
    parent_tool_use_id: null,
    turn_id: null,
    blocks: [{ type: "text", text: "hi" }],
  } as ConversationItem,
];
const context = { context_tokens: 4200, context_window: null, context_usage: null };

function seed(convId: string, machineId: string | null) {
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [{ id: "r1", path: "/srv/app", machineId }] as never,
    conversations: [
      { id: convId, repoId: "r1", cwd: "/srv/app", name: "x", kind: "claude", sessionId: `sess-${convId}`, handle: null },
    ] as never,
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks.fns)) fn.mockReset();
  useAppErrors.setState({ errors: [] });
});

const lines = (convId: string) => useConversationStore.getState().sessions[convId]?.timeline.map((e) => e.id) ?? [];

describe("opening a conversation that runs on a server", () => {
  it("reads its history and context from the server, never from this Mac", async () => {
    seed("r-a", "m1");
    mocks.commands.loadConversationHistory.mockResolvedValue(mocks.ok({ items, context }));
    await loadConversationHistory("r-a");
    expect(mocks.fns.loadConversationHistory).toHaveBeenCalledWith("r-a", "sess-r-a");
    expect(mocks.commands.loadSessionHistory).not.toHaveBeenCalled();
    expect(mocks.commands.loadSessionContext).not.toHaveBeenCalled();
    expect(lines("r-a")).toEqual(["u1", "m1"]);
    expect(useConversationStore.getState().sessions["r-a"].state.context_tokens).toBe(4200);
  });

  it("says a failed read, naming the server, and tries again at the next open", async () => {
    seed("r-b", "m1");
    mocks.commands.loadConversationHistory.mockResolvedValueOnce({
      status: "error",
      error: { kind: "unreachable", server: "Target", reason: "the server did not answer in time" },
    });
    await loadConversationHistory("r-b");
    expect(lines("r-b")).toEqual([]);
    const [error] = useAppErrors.getState().errors;
    expect(error.message).toContain("Target");
    expect(error.detail).toContain("couldn't reach Target");

    mocks.commands.loadConversationHistory.mockResolvedValueOnce(mocks.ok({ items, context }));
    await loadConversationHistory("r-b");
    expect(mocks.fns.loadConversationHistory).toHaveBeenCalledTimes(2);
    expect(lines("r-b")).toEqual(["u1", "m1"]);
  });

  it("a second caller awaits the read already under way (one read, history in when it resolves)", async () => {
    seed("r-c", "m1");
    let release!: () => void;
    mocks.commands.loadConversationHistory.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(mocks.ok({ items, context })))),
    );
    const first = loadConversationHistory("r-c");
    let secondDone = false;
    const second = loadConversationHistory("r-c").then(() => (secondDone = true));
    await Promise.resolve();
    expect(secondDone).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(mocks.fns.loadConversationHistory).toHaveBeenCalledTimes(1);
    expect(lines("r-c")).toEqual(["u1", "m1"]);
  });
});

describe("history landing on a thread that already shows something", () => {
  it("a message sent while the read was on its way stays below the history", async () => {
    seed("r-d", "m1");
    let release!: () => void;
    mocks.commands.loadConversationHistory.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(mocks.ok({ items, context })))),
    );
    const load = loadConversationHistory("r-d");
    useConversationStore.getState().ensureSession("r-d");
    const sent = useConversationStore.getState().addUserTurn("r-d", "typed right away");
    release();
    await load;
    expect(lines("r-d")).toEqual(["u1", "m1", sent]);
  });

  it("a retry after a live attach went ahead keeps the live thread and what it shows", async () => {
    seed("r-e", "m1");
    useConversationsStore.setState((s) => ({
      conversations: s.conversations.map((c) => ({ ...c, handle: "session-9" })),
    }));
    // The first read failed; the attach built the thread from the ring (a later turn only).
    mocks.commands.loadConversationHistory.mockResolvedValueOnce({
      status: "error",
      error: { kind: "unreachable", server: "Target", reason: "timeout" },
    });
    await loadConversationHistory("r-e");
    const cs = useConversationStore.getState();
    cs.ensureSession("r-e");
    cs.applyItems(
      "r-e",
      [
        { kind: "user_message", id: "u7", text: "later", parent_tool_use_id: null, replay: false },
        {
          kind: "turn_result",
          subtype: "success",
          is_error: false,
          result: null,
          api_error_status: null,
          total_cost_usd: null,
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: null,
          ttft_ms: null,
          usage: null,
          uuid: "r7",
        },
      ] as ConversationItem[],
      true,
      false,
    );
    expect(useConversationStore.getState().sessions["r-e"].turnSeen).toBe(false);
    mocks.commands.loadConversationHistory.mockResolvedValueOnce(mocks.ok({ items, context }));
    await loadConversationHistory("r-e");
    // The older history goes above; the live review is not cleared by it.
    expect(lines("r-e")).toEqual(["u1", "m1", "u7", "tr_r7"]);
    expect(useConversationStore.getState().sessions["r-e"].turnSeen).toBe(false);
  });
});

describe("a conversation on this Mac", () => {
  it("still reads this Mac's transcript", async () => {
    seed("l-a", null);
    mocks.commands.loadSessionHistory.mockResolvedValue(mocks.ok(items));
    mocks.commands.loadSessionContext.mockResolvedValue(mocks.ok(context));
    await loadConversationHistory("l-a");
    expect(mocks.fns.loadSessionHistory).toHaveBeenCalledWith("sess-l-a");
    expect(mocks.commands.loadConversationHistory).not.toHaveBeenCalled();
    expect(lines("l-a")).toEqual(["u1", "m1"]);
  });
});
