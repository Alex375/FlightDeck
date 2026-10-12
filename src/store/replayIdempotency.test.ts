// A remote conversation's reattach REPLAY re-delivers history the thread may already show (a
// new session re-joining a server process, a cursor rolled back over a line this build could
// not parse). Applying it again must change nothing, and applying it as hydration must stamp
// no wall-clock timing — while a LOCAL session's behaviour stays exactly as it was.
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationItem } from "../ipc/client";
import { useConversationStore } from "./conversationStore";

const S = "conv";
const st = () => useConversationStore.getState();
const entry = () => st().sessions[S];

const toolTurn = (): ConversationItem[] =>
  [
    { kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null },
    {
      kind: "assistant_message",
      id: "m1",
      parent_tool_use_id: null,
      turn_id: null,
      blocks: [{ type: "text", text: "Reading it." }],
    },
    {
      kind: "assistant_message",
      id: "m1",
      parent_tool_use_id: null,
      turn_id: null,
      blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }],
    },
    { kind: "tool_result", tool_use_id: "t1", content: "ok", is_error: false, parent_tool_use_id: null },
  ] as ConversationItem[];

const result = (uuid: string | null): ConversationItem =>
  ({
    kind: "turn_result",
    subtype: "success",
    is_error: false,
    result: null,
    api_error_status: null,
    total_cost_usd: null,
    num_turns: 1,
    duration_ms: 1000,
    duration_api_ms: null,
    ttft_ms: null,
    usage: null,
    uuid,
  }) as ConversationItem;

beforeEach(() => {
  st().resetSession(S);
});

describe("re-applying the same items changes nothing", () => {
  it("an assistant line delivered twice leaves its blocks unchanged", () => {
    st().applyItems(S, toolTurn(), true);
    const before = entry().turns["m1"].blocks;
    st().applyItems(S, toolTurn(), true);
    expect(entry().turns["m1"].blocks).toEqual(before);
    expect(entry().turns["m1"].blocks).toHaveLength(2);
    expect(entry().timeline.filter((e) => e.kind === "turn")).toHaveLength(1);
  });

  it("a re-delivered line leaves the live buffer typing the next block alone", () => {
    st().applyItems(S, toolTurn().slice(0, 2), false);
    st().appendText(S, "m1", "Now the next");
    st().applyItem(S, toolTurn()[1], true);
    expect(entry().turns["m1"].streamingText).toBe("Now the next");
  });

  it("an old TodoWrite re-delivered does not roll the to-do list back", () => {
    const todo = (id: string, content: string): ConversationItem =>
      ({
        kind: "assistant_message",
        id: `m_${id}`,
        parent_tool_use_id: null,
        turn_id: null,
        blocks: [
          {
            type: "tool_use",
            id,
            name: "TodoWrite",
            input: { todos: [{ content, status: "pending", activeForm: content }] },
          },
        ],
      }) as ConversationItem;
    st().applyItem(S, todo("w1", "old"));
    st().applyItem(S, todo("w2", "new"));
    st().applyItem(S, todo("w1", "old"), true);
    expect(entry().todos.map((t) => t.content)).toEqual(["new"]);
  });

  it("our own prompt echoed back after a re-join adds no second bubble", () => {
    const turnId = st().addUserTurn(S, "ship it");
    st().setTurnWireUuid(S, turnId, "wire-1");
    st().applyItem(
      S,
      { kind: "user_message", id: "wire-1", text: "ship it", parent_tool_use_id: null, replay: true, mid_turn: false },
      true,
    );
    expect(entry().timeline.filter((e) => e.kind === "turn")).toHaveLength(1);
  });

  it("a result delivered twice keeps one footer", () => {
    st().applyItems(S, [...toolTurn(), result("r1")], true);
    st().applyItem(S, result("r1"), true);
    expect(entry().timeline.filter((e) => e.kind === "turn_result")).toHaveLength(1);
  });

  it("a result with no wire identity is still applied each time (the previous behaviour)", () => {
    st().applyItem(S, result(null));
    st().applyItem(S, result(null));
    expect(entry().timeline.filter((e) => e.kind === "turn_result")).toHaveLength(2);
  });

  it("a notice carrying its source is kept once; one without stays as before", () => {
    const notice = (detail: Record<string, unknown>): ConversationItem =>
      ({ kind: "notice", subtype: "command_output", detail }) as ConversationItem;
    st().applyItem(S, notice({ message: "Set model to opus", source_id: "line-1" }));
    st().applyItem(S, notice({ message: "Set model to opus", source_id: "line-1" }), true);
    st().applyItem(S, notice({ message: "plain" }));
    st().applyItem(S, notice({ message: "plain" }));
    expect(entry().timeline.filter((e) => e.kind === "notice")).toHaveLength(3);
  });
});

describe("a replay applied as hydration", () => {
  it("stamps no tool start and freezes no duration", () => {
    st().applyItems(S, toolTurn(), true);
    expect(entry().toolStartedAt["t1"]).toBeUndefined();
    expect(entry().toolDurations["t1"]).toBeUndefined();
  });

  it("stamps no thinking start from a replayed delta", () => {
    st().applyItems(
      S,
      [
        { kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null },
        { kind: "thinking_delta", message_id: "m2", text: "hmm" },
      ] as ConversationItem[],
      true,
    );
    expect(entry().turns["m2"].streamingThinking).toBe("hmm");
    expect(entry().thinkingStartedAt).toBeNull();
  });

  it("the live path still stamps (local behaviour unchanged)", () => {
    for (const item of toolTurn()) st().applyItem(S, item);
    expect(entry().toolStartedAt["t1"]).toBeTypeOf("number");
    expect(entry().toolDurations["t1"]).toBeTypeOf("number");
  });
});

describe("a notice that ends the stream", () => {
  it("settles every turn still streaming, as its lost result would have", () => {
    st().applyItems(S, toolTurn(), false);
    expect(entry().turns["m1"].status).toBe("streaming");
    st().applyItem(S, {
      kind: "notice",
      subtype: "remote_link",
      detail: { message: "The session restarted.", ends_stream: true },
    } as ConversationItem);
    expect(entry().turns["m1"].status).toBe("final");
    expect(entry().openBubble).toEqual({});
  });
});
