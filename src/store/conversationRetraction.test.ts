import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationItem, NormalizedBlock } from "../ipc/client";
import { useConversationStore } from "./conversationStore";

const SESSION = "retraction";
const store = () => useConversationStore.getState();
const entry = () => store().sessions[SESSION];
const apply = (item: ConversationItem) => store().applyItem(SESSION, item);

const text = (t: string): NormalizedBlock => ({ type: "text", text: t });
const tool = (id: string): NormalizedBlock => ({ type: "tool_use", id, name: "Read", input: {} });

const assistant = (id: string, blocks: NormalizedBlock[]): ConversationItem => ({
  kind: "assistant_message",
  id,
  blocks,
  parent_tool_use_id: null,
  turn_id: null,
});

const retracted = (
  messages: { id: string; blocks: NormalizedBlock[]; partial?: boolean }[],
  tool_use_ids: string[] = [],
): ConversationItem => ({
  kind: "retracted",
  messages: messages.map((m) => ({ ...m, partial: m.partial ?? false })),
  tool_use_ids,
});

const turnLines = () => entry().timeline.filter((e) => e.kind === "turn").map((e) => e.id);

describe("a refusal fallback's retraction", () => {
  beforeEach(() => {
    store().dropSession(SESSION);
    store().ensureSession(SESSION);
  });

  it("takes the refused message and its tool result out of the thread", () => {
    apply(assistant("refused", [tool("t1")]));
    apply({ kind: "tool_result", tool_use_id: "t1", content: "x", is_error: false, parent_tool_use_id: null });
    apply(assistant("kept", [text("the answer")]));

    apply(retracted([{ id: "refused", blocks: [tool("t1")] }]));

    expect(entry().turns.refused).toBeUndefined();
    expect(entry().toolResults.t1).toBeUndefined();
    expect(turnLines()).toEqual(["kept"]);
    expect(entry().turns.kept.blocks).toEqual([text("the answer")]);
  });

  it("removes only the blocks it names from a message that keeps others", () => {
    apply(assistant("m1", [text("kept")]));
    apply(assistant("m1", [text("refused")]));

    apply(retracted([{ id: "m1", blocks: [text("refused")] }]));

    expect(entry().turns.m1.blocks).toEqual([text("kept")]);
    expect(turnLines()).toEqual(["m1"]);
  });

  it("drops text that was still streaming when the model refused", () => {
    apply({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null });
    apply({ kind: "text_delta", message_id: "m1", text: "half a sent" });

    apply(retracted([{ id: "m1", blocks: [], partial: true }]));

    expect(entry().turns.m1).toBeUndefined();
    expect(turnLines()).toEqual([]);
    expect(entry().openBubble).toEqual({});
  });

  it("removes a tool result named on its own", () => {
    apply(assistant("m1", [tool("t1")]));
    apply({ kind: "tool_result", tool_use_id: "t1", content: "x", is_error: false, parent_tool_use_id: null });

    apply(retracted([], ["t1"]));

    expect(entry().toolResults.t1).toBeUndefined();
  });

  it("is a no-op for what the thread does not hold, so the CLI's second list changes nothing", () => {
    apply(assistant("m1", [text("hello")]));
    const before = entry();

    apply(retracted([{ id: "gone", blocks: [text("x")] }], ["unknown"]));

    expect(entry()).toBe(before);
  });

  it("moves the replay anchor back with the lines that leave", () => {
    apply(assistant("refused", [text("no")]));
    apply(assistant("kept", [text("yes")]));
    useConversationStore.setState((s) => ({
      sessions: { ...s.sessions, [SESSION]: { ...s.sessions[SESSION], replayAnchor: 2 } },
    }));

    apply(retracted([{ id: "refused", blocks: [text("no")] }]));

    expect(entry().replayAnchor).toBe(1);
  });
});
