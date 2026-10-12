// A remote conversation's history now comes from its server's transcript before the first attach,
// and that attach then replays the daemon's WHOLE ring over it. The ring walks through the same
// history again: what it re-delivers must not double, and what the transcript never held — the
// `turn_result` footers, stream-only notices — must land where the replay IS in that history,
// not stacked under the last message. What comes after the transcript appends as before.
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationItem } from "../ipc/client";
import { useConversationStore } from "./conversationStore";

const S = "conv";
const st = () => useConversationStore.getState();
const entry = () => st().sessions[S];
const lines = () => entry().timeline.map((e) => (e.kind === "turn" ? e.id : `${e.kind}:${e.id}`));

const user = (id: string, replay = false): ConversationItem =>
  ({ kind: "user_message", id, text: `prompt ${id}`, parent_tool_use_id: null, replay }) as ConversationItem;

const started = (id: string): ConversationItem =>
  ({ kind: "message_started", id, role: "assistant", parent_tool_use_id: null }) as ConversationItem;

const said = (id: string): ConversationItem =>
  ({
    kind: "assistant_message",
    id,
    parent_tool_use_id: null,
    turn_id: null,
    blocks: [{ type: "text", text: `answer ${id}` }],
  }) as ConversationItem;

const result = (uuid: string): ConversationItem =>
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

/** What the server transcript restores: messages, no results. */
const transcript = (): ConversationItem[] => [user("u1"), said("m1"), user("u2"), said("m2")];

/** What the daemon's ring replays: the same turns as streamed — echoes, starts, results — then
 *  a turn the transcript did not hold yet. */
const ring = (): ConversationItem[] => [
  user("u1", true),
  started("m1"),
  said("m1"),
  result("r1"),
  user("u2", true),
  started("m2"),
  said("m2"),
  result("r2"),
  user("u3", true),
  started("m3"),
  said("m3"),
  result("r3"),
];

beforeEach(() => {
  st().resetSession(S);
});

describe("a whole-history replay over a history already shown", () => {
  it("puts each replayed footer under its own turn and appends what is new", () => {
    st().applyItems(S, transcript(), true);
    st().reanchorReplay(S);
    st().beginReplayMerge(S);
    st().applyItems(S, ring(), true, true);
    st().endReplayMerge(S);
    expect(lines()).toEqual([
      "u1",
      "m1",
      "turn_result:tr_r1",
      "u2",
      "m2",
      "turn_result:tr_r2",
      "u3",
      "m3",
      "turn_result:tr_r3",
    ]);
    // Nothing doubled: each message once, each answer with its one block.
    expect(entry().turns["m2"].blocks).toHaveLength(1);
    expect(entry().replayMerge).toBeNull();
    expect(entry().replayAnchor).toBe(entry().timeline.length);
  });

  it("holds when the replay arrives in several batches", () => {
    st().applyItems(S, transcript(), true);
    st().beginReplayMerge(S);
    for (const item of ring()) st().applyItems(S, [item], true, true);
    st().endReplayMerge(S);
    expect(lines()).toEqual([
      "u1",
      "m1",
      "turn_result:tr_r1",
      "u2",
      "m2",
      "turn_result:tr_r2",
      "u3",
      "m3",
      "turn_result:tr_r3",
    ]);
  });

  it("a ring that starts mid-history (a server process started later) merges from where it starts", () => {
    st().applyItems(S, transcript(), true);
    st().beginReplayMerge(S);
    st().applyItems(S, ring().slice(4), true, true);
    st().endReplayMerge(S);
    expect(lines()).toEqual(["u1", "m1", "u2", "m2", "turn_result:tr_r2", "u3", "m3", "turn_result:tr_r3"]);
  });

  it("without a merge (the old way) the footers stacked at the bottom", () => {
    st().applyItems(S, transcript(), true);
    st().applyItems(S, ring().slice(0, 8), true, true);
    expect(lines()).toEqual(["u1", "m1", "u2", "m2", "turn_result:tr_r1", "turn_result:tr_r2"]);
  });

  it("an empty timeline does not merge: the replay simply builds it", () => {
    st().ensureSession(S);
    st().beginReplayMerge(S);
    expect(entry().replayMerge).toBeNull();
    st().applyItems(S, ring(), true, true);
    expect(lines()).toEqual([
      "u1",
      "m1",
      "turn_result:tr_r1",
      "u2",
      "m2",
      "turn_result:tr_r2",
      "u3",
      "m3",
      "turn_result:tr_r3",
    ]);
  });

  it("live items after the replay append as usual", () => {
    st().applyItems(S, transcript(), true);
    st().beginReplayMerge(S);
    st().applyItems(S, ring().slice(0, 4), true, true);
    st().endReplayMerge(S);
    st().applyItem(S, started("m9"));
    expect(lines()[lines().length - 1]).toBe("m9");
  });
});
