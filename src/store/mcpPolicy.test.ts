import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({ commands: { applySessionOverrides: vi.fn() } }));
vi.mock("./conversationsStore", () => ({ useConversationsStore: { getState: vi.fn() } }));

import { commands } from "../ipc/client";
import { useConversationsStore } from "./conversationsStore";
import {
  applyPolicyChange,
  clearConvPolicy,
  noteServerTools,
  sessionOverridesForConv,
  useMcpPolicy,
} from "./mcpPolicy";

const SEND = "mcp__claude_ai_Gmail__send_message";
const apply = vi.mocked(commands.applySessionOverrides);
const convs = (list: { id: string; repoId: string; handle: string | null }[]) =>
  vi.mocked(useConversationsStore.getState).mockReturnValue({
    conversations: list.map((c) => ({ ...c, kind: "claude", name: c.id })),
  } as never);

beforeEach(() => {
  localStorage.clear();
  useMcpPolicy.setState({ global: { tools: {}, servers: {}, plugins: {} }, repos: {}, convs: {}, toolCache: {} }, true);
  apply.mockReset();
  apply.mockResolvedValue({ status: "ok", data: null });
  convs([]);
});

describe("Flight Deck's permission cascade", () => {
  it("a Global change reaches every live Claude conversation, resolved for each", async () => {
    convs([
      { id: "c1", repoId: "r1", handle: "s1" },
      { id: "c2", repoId: "r2", handle: "s2" },
      { id: "c3", repoId: "r1", handle: null },
    ]);
    await applyPolicyChange({ scope: "repository", key: "r1" }, { tools: [{ tool: SEND, kind: "allow" }] });
    apply.mockClear();
    await applyPolicyChange({ scope: "global", key: null }, { tools: [{ tool: SEND, kind: "deny" }] });
    expect(apply).toHaveBeenCalledTimes(2);
    // r1 loosened it: its conversation stays allowed; r2 follows Global.
    expect(apply).toHaveBeenCalledWith("s1", expect.objectContaining({ allow: [SEND], deny: [] }), false);
    expect(apply).toHaveBeenCalledWith("s2", expect.objectContaining({ allow: [], deny: [SEND] }), false);
  });

  it("a Repository change reaches only that repository's conversations", async () => {
    convs([
      { id: "c1", repoId: "r1", handle: "s1" },
      { id: "c2", repoId: "r2", handle: "s2" },
    ]);
    await applyPolicyChange({ scope: "repository", key: "r1" }, { plugins: [{ id: "p@m", enabled: false }] });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("s1", expect.objectContaining({ enabled_plugins: { "p@m": false } }), true);
  });

  it("a conversation's own change is only kept once its running session accepted it", async () => {
    convs([{ id: "c1", repoId: "r1", handle: "s1" }]);
    apply.mockResolvedValue({ status: "error", error: "nope" });
    await expect(
      applyPolicyChange({ scope: "conversation", key: "c1" }, { tools: [{ tool: SEND, kind: "deny" }] }),
    ).rejects.toThrow(/nope/);
    expect(useMcpPolicy.getState().convs).toEqual({});
  });

  it("a spawn gets the resolved set; nothing at all → null", async () => {
    expect(sessionOverridesForConv("c1", "r1")).toBeNull();
    await applyPolicyChange({ scope: "conversation", key: "c1" }, { servers: [{ server: "claude.ai Gmail", on: false }] });
    expect(sessionOverridesForConv("c1", "r1")).toMatchObject({ deny: ["mcp__claude_ai_Gmail"] });
    expect(sessionOverridesForConv("c2", "r1")).toBeNull();
    clearConvPolicy("c1");
    expect(sessionOverridesForConv("c1", "r1")).toBeNull();
  });

  it("persists across a reload, and remembers each server's tools", async () => {
    await applyPolicyChange({ scope: "global", key: null }, { tools: [{ tool: SEND, kind: "ask" }] });
    noteServerTools("claude.ai Gmail", ["send_message"]);
    const stored = JSON.parse(localStorage.getItem("tosse:mcpPolicy")!);
    expect(stored.global.tools).toEqual({ [SEND]: "ask" });
    expect(stored.toolCache).toEqual({ mcp__claude_ai_Gmail: ["send_message"] });
  });
});
