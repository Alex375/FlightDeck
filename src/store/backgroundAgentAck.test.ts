import { describe, it, expect } from "vitest";
import { useConversationStore } from "./conversationStore";
import type { ConversationItem, NormalizedBlock } from "../ipc/client";

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
