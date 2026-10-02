import { describe, it, expect } from "vitest";
import { agentStreamKey, useConversationStore } from "./conversationStore";
import type { BackgroundTask, ConversationItem, NormalizedBlock } from "../ipc/client";

// End-to-end reducer test for the "detached-by-ack" recovery: a background sub-agent whose
// live `Agent` block arrived WITHOUT `run_in_background` (a transient wire drop) must still
// be folded into `bgAgentIds` from its launch ack — so the AgentBar lists it and the inline
// hiding drops it. Drives the real store reducer (`applyItem`) end to end.

const store = () => useConversationStore.getState();
const bgIds = (session: string) => store().sessions[session]?.bgAgentIds ?? [];

// The real ack a detached sub-agent returns at launch (captured verbatim).
const DETACHED_ACK =
  "Async agent launched successfully.\nagentId: abc123\n" +
  "The agent is working in the background.\noutput_file: /tmp/x/tasks/abc123.output";

// The launch ack of CLI 2.1.286, verbatim (live capture of 2026-10-01). Its preamble names
// "the agentId below" BEFORE the real `agentId:` line — the trap `agentIdFromResult` fell in.
const ACK_2_1_286 =
  "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n" +
  "agentId: a68e26aa615c9f436 (internal ID - do not mention to user. Use SendMessage with to: 'a68e26aa615c9f436', summary: '<5-10 word recap>' to continue this agent.)\n" +
  "The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.\n" +
  "Do not duplicate this agent's work — avoid working with the same files or topics it is using.\n" +
  "output_file: /private/tmp/claude-501/x/s/tasks/a68e26aa615c9f436.output\n" +
  "Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.";

const tool = (id: string, name: string, input: unknown = {}): NormalizedBlock => ({
  type: "tool_use",
  id,
  name,
  input: input as never,
});

function assistant(session: string, id: string, blocks: NormalizedBlock[]) {
  store().ensureSession(session);
  store().applyItem(session, {
    kind: "assistant_message",
    id,
    blocks,
    parent_tool_use_id: null,
  } as ConversationItem);
}

function toolResult(session: string, toolUseId: string, content: unknown, isError = false) {
  store().applyItem(session, {
    kind: "tool_result",
    tool_use_id: toolUseId,
    content: content as never,
    is_error: isError,
    parent_tool_use_id: null,
  } as ConversationItem);
}

describe("detached sub-agent recovery from the launch ack", () => {
  it("folds an Agent into bgAgentIds from its ack even without run_in_background", () => {
    const s = "s-ack";
    assistant(s, "m1", [tool("tu1", "Agent", { subagent_type: "Explore", prompt: "p" })]);
    // Input carried no flag → not detected at write time.
    expect(bgIds(s)).not.toContain("tu1");
    // The launch ack arrives → recovered as detached.
    toolResult(s, "tu1", [{ type: "text", text: DETACHED_ACK }]);
    expect(bgIds(s)).toContain("tu1");
  });

  it("still detects a run_in_background Agent from the input flag (unchanged path)", () => {
    const s = "s-flag";
    assistant(s, "m1", [tool("tu2", "Agent", { run_in_background: true })]);
    expect(bgIds(s)).toContain("tu2");
  });

  it("does NOT fold a foreground Agent (no flag, real output result)", () => {
    const s = "s-fg";
    assistant(s, "m1", [tool("tu3", "Agent", { subagent_type: "Explore" })]);
    toolResult(s, "tu3", [{ type: "text", text: "Here is the codebase summary: …" }]);
    expect(bgIds(s)).not.toContain("tu3");
  });

  it("does NOT fold a foreground Agent whose output merely mentions agentId + background (the false-positive the review caught)", () => {
    // A foreground review/summary agent describing THIS feature: its free-prose output cites
    // "agentId" and "working in the background", but is NOT a launch ack. Folding it would
    // silently hide the foreground card + transcript — the exact silent content-loss to avoid.
    const s = "s-fg-prose";
    assistant(s, "m1", [tool("tu6", "Agent", { subagent_type: "Explore" })]);
    toolResult(s, "tu6", [
      { type: "text", text: "The agentId identifies each sub-agent while it is working in the background until done." },
    ]);
    expect(bgIds(s)).not.toContain("tu6");
  });

  it("is Agent-only: a non-Agent tool whose result looks like the ack is ignored", () => {
    const s = "s-bash";
    assistant(s, "m1", [tool("tu4", "Bash", { command: "x" })]);
    toolResult(s, "tu4", [{ type: "text", text: DETACHED_ACK }]);
    expect(bgIds(s)).not.toContain("tu4");
  });

  it("does not duplicate an id already flagged from the input", () => {
    const s = "s-dup";
    assistant(s, "m1", [tool("tu5", "Agent", { run_in_background: true })]);
    toolResult(s, "tu5", [{ type: "text", text: DETACHED_ACK }]);
    expect(bgIds(s).filter((id) => id === "tu5")).toHaveLength(1);
  });

  it("recognises the CLI 2.1.286 launch ack verbatim", () => {
    const s = "s-ack-2286";
    assistant(s, "m1", [tool("tu7", "Agent", { subagent_type: "general-purpose", prompt: "p" })]);
    toolResult(s, "tu7", [{ type: "text", text: ACK_2_1_286 }]);
    expect(bgIds(s)).toContain("tu7");
  });

  it("is fail-safe: a detached ack for an UNKNOWN tool_use_id (no matching block) is NOT folded", () => {
    // The block-not-found branch: a valid detached ack arrives, but no assistant_message ever
    // declared this tool_use → we can't confirm it's an Agent → must NOT fold (never hide an
    // unconfirmed tool_use). Locks the fail-safe `return false`.
    const s = "s-ghost";
    store().ensureSession(s);
    toolResult(s, "ghost", [{ type: "text", text: DETACHED_ACK }]);
    expect(bgIds(s)).not.toContain("ghost");
  });
});

// Task 9ab0edf7 (review): a woken run's drill-in follows THAT run — the SendMessage that woke
// it, and only the sub-thread turns that came after it.
describe("wakes", () => {
  function subTurn(s: string, id: string, parent: string) {
    store().applyItem(s, {
      kind: "assistant_message",
      id,
      blocks: [{ type: "text", text: id }],
      parent_tool_use_id: parent,
    } as ConversationItem);
  }

  it("records each main-thread SendMessage, by its id, with where the sub-threads stood", () => {
    const s = "s-wake-cut";
    assistant(s, "m1", [tool("tu-launch", "Agent", { run_in_background: true, prompt: "p" })]);
    subTurn(s, "sub1", "tu-launch");
    subTurn(s, "sub2", "tu-launch");
    assistant(s, "m2", [tool("tu-send", "SendMessage", { to: "agentX", message: "now do KIWI" })]);
    subTurn(s, "sub3", "tu-launch");
    const wake = store().sessions[s]!.wakes["tu-send"];
    expect(wake).toEqual({ message: "now do KIWI", cuts: { "tu-launch": 2 } });
    // The woken run's own turns are those past the cut.
    expect(store().sessions[s]!.subThreads["tu-launch"]!.slice(wake.cuts["tu-launch"])).toEqual(["sub3"]);
  });

  // Round 3: a later SendMessage to the same agent (one that only QUEUES a message to the
  // running agent, or that fails) must not move the cut of the one that started the run.
  it("keeps every SendMessage's own cut — a later one never moves an earlier one", () => {
    const s = "s-wake-again";
    assistant(s, "m1", [tool("tu-launch", "Agent", { prompt: "p" })]);
    subTurn(s, "sub1", "tu-launch");
    assistant(s, "m2", [tool("tu-send", "SendMessage", { to: "agentX", message: "a" })]);
    subTurn(s, "sub2", "tu-launch");
    assistant(s, "m2", [tool("tu-send", "SendMessage", { to: "agentX", message: "a" })]); // re-applied
    assistant(s, "m3", [tool("tu-send2", "SendMessage", { to: "agentX", message: "also b" })]);
    expect(store().sessions[s]!.wakes["tu-send"]).toEqual({ message: "a", cuts: { "tu-launch": 1 } });
    expect(store().sessions[s]!.wakes["tu-send2"]).toEqual({ message: "also b", cuts: { "tu-launch": 2 } });
  });

  it("ignores a sub-agent's own SendMessage", () => {
    const s = "s-wake-nested";
    store().ensureSession(s);
    store().applyItem(s, {
      kind: "assistant_message",
      id: "m1",
      blocks: [tool("tu-nested", "SendMessage", { to: "grandchild", message: "go" })],
      parent_tool_use_id: "tu-child",
    } as ConversationItem);
    expect(store().sessions[s]!.wakes["tu-nested"]).toBeUndefined();
  });
});

// Round 3: SendMessage reports a failure in its body (`success:false`), never via `is_error`.
describe("failed SendMessage", () => {
  it("is stored as an error result, so its step does not read as a success", () => {
    const s = "s-send-failed";
    assistant(s, "m1", [tool("tu-send", "SendMessage", { to: "agentX", message: "go" })]);
    toolResult(s, "tu-send", [
      { type: "text", text: '{"success":false,"message":"Agent agentX was stopped by the user and was not resumed"}' },
    ]);
    expect(store().sessions[s]!.toolResults["tu-send"]!.isError).toBe(true);
  });

  it("leaves a successful SendMessage, and any other tool's success:false body, alone", () => {
    const s = "s-send-ok";
    assistant(s, "m1", [tool("tu-send", "SendMessage", { to: "agentX" }), tool("tu-mcp", "mcp__x__y")]);
    toolResult(s, "tu-send", [{ type: "text", text: '{"success":true,"message":"Resuming agent agentX"}' }]);
    toolResult(s, "tu-mcp", [{ type: "text", text: '{"success":false}' }]);
    expect(store().sessions[s]!.toolResults["tu-send"]!.isError).toBe(false);
    expect(store().sessions[s]!.toolResults["tu-mcp"]!.isError).toBe(false);
  });
});

// Task 9ab0edf7: where a drill-down finds a sub-agent's LIVE messages. A woken agent the socle
// could not re-key (a session hosted on another machine) carries the SendMessage's id, while
// its messages keep streaming under the launching Agent — found from the rehydrated ack.
describe("agentStreamKey", () => {
  const task = (over: Partial<BackgroundTask>): BackgroundTask => ({
    task_id: "a68e26aa615c9f436",
    kind: "agent",
    tool_use_id: null,
    label: null,
    command: null,
    subagent_type: null,
    model: null,
    agent_id: null,
    status: "running",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: null,
    woken_by: null,
    backgrounded: null,
    ambient: false,
    owned_by_subagent: false,
    ...over,
  });

  function launched(s: string) {
    assistant(s, "m1", [tool("tu-launch", "Agent", { run_in_background: true, prompt: "p" })]);
    toolResult(s, "tu-launch", [{ type: "text", text: ACK_2_1_286 }]);
    assistant(s, "m2", [tool("tu-send", "SendMessage", { to: "a68e26aa615c9f436", message: "go" })]);
    toolResult(s, "tu-send", [
      { type: "text", text: '{"success":true,"message":"Resuming agent a68e26a","resumedAgentId":"a68e26aa615c9f436"}' },
    ]);
  }

  it("is the task's own tool_use_id for a task that was not woken", () => {
    const s = "s-key-plain";
    launched(s);
    expect(agentStreamKey(store().sessions[s], task({ tool_use_id: "tu-send" }))).toBe("tu-send");
  });

  it("keeps a woken task already keyed on its launch", () => {
    const s = "s-key-rekeyed";
    launched(s);
    const t = task({ tool_use_id: "tu-launch", woken_by: "tu-send", agent_id: "a68e26aa615c9f436" });
    expect(agentStreamKey(store().sessions[s], t)).toBe("tu-launch");
  });

  it("finds the launching Agent of a woken task keyed on its SendMessage", () => {
    const s = "s-key-cold";
    launched(s);
    const t = task({ tool_use_id: "tu-send", woken_by: "tu-send", agent_id: "a68e26aa615c9f436" });
    expect(agentStreamKey(store().sessions[s], t)).toBe("tu-launch");
  });

  it("finds a FOREGROUND launch whose report names another 'agent_id:' before the CLI trailer", () => {
    const s = "s-key-fg-prose";
    assistant(s, "m1", [tool("tu-fg", "Agent", { prompt: "p" })]);
    toolResult(s, "tu-fg", [
      {
        type: "text",
        text: "The task has `agent_id: Option<String>`.\n\nagentId: a68e26aa615c9f436 (use SendMessage with to: 'a68e26aa615c9f436' to continue this agent)",
      },
    ]);
    const t = task({ tool_use_id: "tu-send", woken_by: "tu-send", agent_id: "a68e26aa615c9f436" });
    expect(agentStreamKey(store().sessions[s], t)).toBe("tu-fg");
  });

  it("never picks a launch that merely MENTIONS the agent (round 3)", () => {
    const s = "s-key-mention";
    assistant(s, "m1", [tool("tu-other", "Agent", { prompt: "review it" })]);
    toolResult(s, "tu-other", [
      {
        type: "text",
        text: "Reviewed subagents/agent-a68e26aa615c9f436.jsonl (agentId: a68e26aa615c9f436).\n\nagentId: bbbbbbbbbbbbbbbb1 (use SendMessage with to: 'bbbbbbbbbbbbbbbb1')",
      },
    ]);
    const t = task({ tool_use_id: "tu-send", woken_by: "tu-send", agent_id: "a68e26aa615c9f436" });
    expect(agentStreamKey(store().sessions[s], t)).toBe("tu-send");
  });

  it("falls back to the task's own id when no launch names its agent", () => {
    const s = "s-key-none";
    launched(s);
    const t = task({ tool_use_id: "tu-send", woken_by: "tu-send", agent_id: "someone-else" });
    expect(agentStreamKey(store().sessions[s], t)).toBe("tu-send");
    expect(agentStreamKey(undefined, t)).toBe("tu-send");
  });
});

// The CLI's own word (`is_backgrounded: true` on `task_started`, or on a mid-run
// `task_updated` when a foreground sub-agent is moved to the background) is folded the same
// way — main thread only, never for a block we can't find.
describe("detached sub-agent from the CLI's live is_backgrounded", () => {
  it("folds a main-thread Agent the CLI reports in the background (e.g. moved there mid-run)", () => {
    const s = "s-live-bg";
    assistant(s, "m1", [tool("tu1", "Agent", { run_in_background: false })]);
    expect(bgIds(s)).not.toContain("tu1");
    store().noteBackgroundedAgent(s, "tu1");
    expect(bgIds(s)).toContain("tu1");
  });

  it("never folds a sub-agent's own Agent call (a grandchild must not reach the AgentBar)", () => {
    const s = "s-live-nested";
    store().ensureSession(s);
    store().applyItem(s, {
      kind: "assistant_message",
      id: "m-sub",
      blocks: [tool("tu-nested", "Agent", {})],
      parent_tool_use_id: "tu-parent",
    } as ConversationItem);
    store().noteBackgroundedAgent(s, "tu-nested");
    expect(bgIds(s)).not.toContain("tu-nested");
  });

  it("never folds a non-Agent block or one it can't find (folding hides the inline card)", () => {
    const s = "s-live-other";
    assistant(s, "m1", [tool("tu-send", "SendMessage", { to: "abc" })]);
    store().noteBackgroundedAgent(s, "tu-send");
    store().noteBackgroundedAgent(s, "missing");
    expect(bgIds(s)).toEqual([]);
  });
});
