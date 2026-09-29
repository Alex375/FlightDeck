import { describe, expect, it } from "vitest";
import type { ConversationItem } from "../ipc/client";
import { useConversationStore } from "./conversationStore";

/** A small replayed history: a user prompt, an assistant message with a tool call, its result. */
function history(): ConversationItem[] {
  return [
    { kind: "user_message", id: "u1", text: "Read the file", mid_turn: false },
    { kind: "message_started", id: "a1", parent_tool_use_id: null },
    {
      kind: "assistant_message",
      id: "a1",
      parent_tool_use_id: null,
      blocks: [
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/a.ts" } },
      ],
    },
    { kind: "tool_result", tool_use_id: "t1", content: "ok", is_error: false, parent_tool_use_id: null },
  ] as unknown as ConversationItem[];
}

describe("applyItems (a replayed history in one commit)", () => {
  it("builds the same entry as applying the items one by one", () => {
    const st = useConversationStore.getState();
    for (const item of history()) st.applyItem("one-by-one", item, true);
    st.applyItems("batched", history(), true);
    const { sessions } = useConversationStore.getState();
    const strip = (e: (typeof sessions)[string]) => ({
      timeline: e.timeline,
      turns: e.turns,
      toolResults: e.toolResults,
    });
    expect(strip(sessions["batched"])).toEqual(strip(sessions["one-by-one"]));
    expect(sessions["batched"].timeline.length).toBeGreaterThan(0);
  });

  it("notifies subscribers once, however long the history", () => {
    let writes = 0;
    const unsubscribe = useConversationStore.subscribe(() => {
      writes += 1;
    });
    useConversationStore.getState().applyItems("counted", history(), true);
    unsubscribe();
    expect(writes).toBe(1);
  });
});
