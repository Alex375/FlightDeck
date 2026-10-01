import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({ commands: { applySessionOverrides: vi.fn() } }));
vi.mock("./conversationsStore", () => ({ useConversationsStore: { getState: vi.fn() } }));

import { commands } from "../ipc/client";
import { useConversationsStore } from "./conversationsStore";
import type { SessionOverrides } from "../ipc/bindings";
import {
  applyPolicyChange,
  clearAllPolicy,
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
  it("runs changes one at a time, so two made during one round trip both stick", async () => {
    convs([{ id: "c1", repoId: "r1", handle: "s1" }]);
    let release!: () => void;
    apply.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ status: "ok", data: null }))),
    );
    // A plugin Clear on the conversation, still waiting on its session…
    useMcpPolicy.setState({ ...useMcpPolicy.getState(), convs: { c1: { tools: {}, servers: {}, plugins: { "p@m": true } } } }, true);
    const clear = applyPolicyChange({ scope: "conversation", key: "c1" }, { plugins: [{ id: "p@m", enabled: null }] });
    // …while a server is turned off at the same level.
    const toggle = applyPolicyChange({ scope: "conversation", key: "c1" }, { servers: [{ server: "claude.ai Gmail", on: false }] });
    await Promise.resolve();
    expect(apply).toHaveBeenCalledTimes(1); // the second waits for the first
    release();
    await Promise.all([clear, toggle]);
    const level = useMcpPolicy.getState().convs.c1;
    expect(level.plugins).toEqual({}); // the Clear was NOT undone by the later write
    expect(level.servers).toEqual({ mcp__claude_ai_Gmail: false });
    // …and the live session was told the same: the second push starts from the first.
    const second = apply.mock.calls[1][1] as SessionOverrides;
    expect(second.enabled_plugins ?? {}).not.toHaveProperty("p@m");
    expect(second.deny).toEqual(["mcp__claude_ai_Gmail"]);
  });

  it("keeps the tool cache a live session refreshed during the round trip", async () => {
    convs([{ id: "c1", repoId: "r1", handle: "s1" }]);
    let release!: () => void;
    apply.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ status: "ok", data: null }))),
    );
    const change = applyPolicyChange({ scope: "conversation", key: "c1" }, { servers: [{ server: "a", on: false }] });
    await Promise.resolve();
    noteServerTools("claude.ai Gmail", ["send_message"]);
    release();
    await change;
    const d = useMcpPolicy.getState();
    expect(d.toolCache.mcp__claude_ai_Gmail).toEqual(["send_message"]);
    expect(d.convs.c1.servers).toEqual({ mcp__a: false });
  });

  it("does not bring back a conversation removed while its change waited", async () => {
    convs([{ id: "c1", repoId: "r1", handle: "s1" }]);
    let release!: () => void;
    apply.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ status: "ok", data: null }))),
    );
    const change = applyPolicyChange({ scope: "conversation", key: "c1" }, { servers: [{ server: "a", on: false }] });
    await Promise.resolve();
    convs([]); // c1 removed meanwhile (its teardown clears its level)
    clearConvPolicy("c1");
    release();
    await change;
    expect(useMcpPolicy.getState().convs).not.toHaveProperty("c1");
  });

  it("does not bring back a level wiped while its change waited", async () => {
    convs([{ id: "c1", repoId: "r1", handle: "s1" }]);
    let release!: () => void;
    apply.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ status: "ok", data: null }))),
    );
    const change = applyPolicyChange({ scope: "conversation", key: "c1" }, { servers: [{ server: "a", on: false }] });
    await Promise.resolve();
    clearAllPolicy();
    release();
    await change;
    expect(useMcpPolicy.getState().convs).toEqual({});
  });

  it("a refused change does not block the next one", async () => {
    convs([{ id: "c1", repoId: "r1", handle: "s1" }]);
    apply.mockResolvedValueOnce({ status: "error", error: "gone" });
    await expect(
      applyPolicyChange({ scope: "conversation", key: "c1" }, { servers: [{ server: "a", on: false }] }),
    ).rejects.toThrow("gone");
    await applyPolicyChange({ scope: "conversation", key: "c1" }, { servers: [{ server: "b", on: false }] });
    expect(useMcpPolicy.getState().convs.c1.servers).toEqual({ mcp__b: false });
  });

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
    convs([{ id: "c1", repoId: "r1", handle: null }]); // a conversation not spawned yet
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
