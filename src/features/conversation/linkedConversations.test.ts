import { describe, expect, it } from "vitest";
import type { JsonValue, NormalizedBlock } from "../../ipc/client";
import type { SessionEntry } from "../../store/types";
import {
  CREATE_CONVERSATION_TOOL,
  SEND_MESSAGE_TOOL,
  buildAgentMessageEnvelope,
} from "./agentMessage";
import {
  clearAllLinkedCache,
  clearLinkedCache,
  failureNote,
  linkSummary,
  memoizedLinked,
  selectLinkedConversations,
} from "./linkedConversations";

const SELF = "conv-self";

/** A received envelope, exactly as the executor builds it. */
function envelope(from: string, messageId: string, title = "Refactor auth", repo = "tosse-code"): string {
  return buildAgentMessageEnvelope(
    { conversationId: from, title, repo, backend: "claude" },
    messageId,
    "Can you check the login flow?",
  );
}

function send(id: string, conversationId: string | undefined, text = "hello"): NormalizedBlock {
  const input: Record<string, unknown> = { text };
  if (conversationId !== undefined) input.conversation_id = conversationId;
  return { type: "tool_use", id, name: SEND_MESSAGE_TOOL, input } as unknown as NormalizedBlock;
}

function create(id: string, input: Record<string, unknown>): NormalizedBlock {
  return { type: "tool_use", id, name: CREATE_CONVERSATION_TOOL, input } as unknown as NormalizedBlock;
}

/** The executor's JSON, pretty-printed as MCP text — the shape the tool_result carries. */
function ok(json: Record<string, unknown>): JsonValue {
  return [{ type: "text", text: JSON.stringify(json, null, 2) }] as unknown as JsonValue;
}
function refusal(text: string): JsonValue {
  return [{ type: "text", text }] as unknown as JsonValue;
}

type TurnSpec =
  | { id: string; user: string; parent?: string | null; midTurn?: boolean }
  | { id: string; blocks: NormalizedBlock[]; parent?: string | null };

/** A minimal SessionEntry with just the fields the derivation reads. */
function entryOf(
  turns: TurnSpec[],
  results: Record<string, { content: JsonValue; isError?: boolean }> = {},
): SessionEntry {
  const turnMap: Record<string, unknown> = {};
  const timeline: Array<{ kind: "turn"; id: string }> = [];
  for (const t of turns) {
    const user = "user" in t;
    turnMap[t.id] = {
      id: t.id,
      role: user ? "user" : "assistant",
      status: "final",
      streamingText: user ? t.user : "",
      streamingThinking: "",
      blocks: user ? [] : t.blocks,
      parentToolUseId: t.parent ?? null,
      hasThinking: false,
      injectedMidTurn: user ? t.midTurn : undefined,
    };
    timeline.push({ kind: "turn", id: t.id });
  }
  const toolResults: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(results)) {
    toolResults[id] = { toolUseId: id, content: r.content, isError: !!r.isError, parentToolUseId: null };
  }
  return { timeline, turns: turnMap, toolResults, toolStartedAt: {} } as unknown as SessionEntry;
}

describe("selectLinkedConversations — received", () => {
  it("is empty (and ref-stable) for no entry or a thread with no exchange", () => {
    const none = selectLinkedConversations(undefined);
    expect(none).toEqual([]);
    expect(selectLinkedConversations(entryOf([{ id: "u1", user: "hi" }]))).toBe(none);
  });

  it("lists a sender from its envelope, with snapshots and both anchors", () => {
    const e = entryOf([{ id: "user_0", user: envelope("conv-a", "m1") }]);
    expect(selectLinkedConversations(e, SELF)).toEqual([
      {
        partnerId: "conv-a",
        sent: 0,
        unconfirmed: 0,
        received: 1,
        created: false,
        failed: 0,
        failureReason: null,
        snapshotTitle: "Refactor auth",
        snapshotRepo: "tosse-code",
        // Its send card in ITS thread; the arrival card in ours.
        remoteAnchor: { kind: "sent", messageId: "m1" },
        localAnchor: { kind: "received", messageId: "m1" },
        lastOrder: 0,
      },
    ]);
  });

  it("counts a mid-turn arrival restored from disk like a live one", () => {
    // Reload: the queued_command restore — a transcript uuid id, mid_turn → injectedMidTurn.
    const e = entryOf([{ id: "9f1c-uuid", user: envelope("conv-a", "m1"), midTurn: true }]);
    expect(selectLinkedConversations(e, SELF)[0]).toMatchObject({ partnerId: "conv-a", received: 1 });
  });

  it("ignores a prompt that merely mentions the tag, and an envelope naming no sender", () => {
    const prose = "Why does <flightdeck-message> show up in my thread?";
    const anonymous = "<flightdeck-message>\n<from>X</from>\n<body>\nhi\n</body>\n</flightdeck-message>";
    const e = entryOf([
      { id: "u1", user: prose },
      { id: "u2", user: anonymous },
    ]);
    expect(selectLinkedConversations(e, SELF)).toEqual([]);
  });

  it("an arrival with no message id counts, but keeps the anchors on the newest exchange that has one", () => {
    // An envelope from before message ids: its card carries no id to be found by.
    const noId = "<flightdeck-message>\n<from>A</from>\n<from-conversation-id>conv-a</from-conversation-id>\n<body>\nhi\n</body>\n</flightdeck-message>";
    const alone = selectLinkedConversations(entryOf([{ id: "u1", user: noId }]), SELF)[0];
    expect(alone).toMatchObject({ received: 1, remoteAnchor: null, localAnchor: null });
    const after = selectLinkedConversations(
      entryOf([
        { id: "u1", user: envelope("conv-a", "m1") },
        { id: "u2", user: noId },
      ]),
      SELF,
    )[0];
    expect(after).toMatchObject({
      received: 2,
      lastOrder: 1,
      remoteAnchor: { kind: "sent", messageId: "m1" },
      localAnchor: { kind: "received", messageId: "m1" },
    });
  });

  it("ignores a sub-agent's user turn and never lists the conversation itself", () => {
    const e = entryOf([
      { id: "u1", user: envelope("conv-a", "m1"), parent: "toolu_task" },
      { id: "u2", user: envelope(SELF, "m2") },
    ]);
    expect(selectLinkedConversations(e, SELF)).toEqual([]);
  });
});

describe("selectLinkedConversations — sent", () => {
  it("counts a delivered send and lands on the recipient's arrival card", () => {
    const e = entryOf([{ id: "a1", blocks: [send("t1", "conv-b")] }], {
      t1: { content: ok({ conversation_id: "conv-b", delivered: true, message_id: "m9" }) },
    });
    expect(selectLinkedConversations(e, SELF)).toEqual([
      expect.objectContaining({
        partnerId: "conv-b",
        sent: 1,
        unconfirmed: 0,
        received: 0,
        failed: 0,
        // A send records no recipient name: the widget reads it live, else an em dash.
        snapshotTitle: null,
        remoteAnchor: { kind: "received", messageId: "m9" },
        localAnchor: { kind: "sentTool", toolUseId: "t1" },
      }),
    ]);
  });

  it("counts a queued send (the recipient was mid-turn) as sent", () => {
    const e = entryOf([{ id: "a1", blocks: [send("t1", "conv-b")] }], {
      t1: { content: ok({ conversation_id: "conv-b", delivered: true, message_id: "m9", note: "queued" }) },
    });
    expect(selectLinkedConversations(e, SELF)[0]).toMatchObject({ sent: 1, unconfirmed: 0 });
  });

  it("counts a resultless send as sent but unconfirmed, with no remote anchor", () => {
    const e = entryOf([{ id: "a1", blocks: [send("t1", "conv-b")] }]);
    expect(selectLinkedConversations(e, SELF)[0]).toMatchObject({
      partnerId: "conv-b",
      sent: 1,
      unconfirmed: 1,
      remoteAnchor: null,
      localAnchor: { kind: "sentTool", toolUseId: "t1" },
    });
  });

  it("trusts the recipient the result resolved over the input", () => {
    const e = entryOf([{ id: "a1", blocks: [send("t1", "conv-typo")] }], {
      t1: { content: ok({ conversation_id: "conv-b", delivered: true, message_id: "m9" }) },
    });
    expect(selectLinkedConversations(e, SELF).map((l) => l.partnerId)).toEqual(["conv-b"]);
  });

  it("leaves out a partner that was only ever refused — nothing crossed", () => {
    const e = entryOf([{ id: "a1", blocks: [send("t1", "conv-gone"), send("t2", undefined)] }], {
      t1: { content: refusal("no conversation with id 'conv-gone' (see list_conversations)"), isError: true },
      t2: { content: refusal("send_message: a conversation cannot message itself"), isError: true },
    });
    expect(selectLinkedConversations(e, SELF)).toEqual([]);
  });

  it("flags a refusal next to real exchanges, keeping the last delivered one as the jump", () => {
    const e = entryOf(
      [
        { id: "a1", blocks: [send("t1", "conv-b")] },
        { id: "a2", blocks: [send("t2", "conv-b")] },
      ],
      {
        t1: { content: ok({ conversation_id: "conv-b", delivered: true, message_id: "m1" }) },
        t2: { content: refusal("The user doesn't want to proceed with this tool use."), isError: true },
      },
    );
    expect(selectLinkedConversations(e, SELF)[0]).toMatchObject({
      sent: 1,
      failed: 1,
      failureReason: "The user doesn't want to proceed with this tool use.",
      // Nothing of the refused send reached the partner…
      remoteAnchor: { kind: "received", messageId: "m1" },
      // …but its card is the newest thing in OUR thread.
      localAnchor: { kind: "sentTool", toolUseId: "t2" },
    });
  });

  it("ignores a sub-agent's send (skipped on reload, so it would change the list)", () => {
    const e = entryOf([{ id: "a1", blocks: [send("t1", "conv-b")], parent: "toolu_task" }], {
      t1: { content: ok({ conversation_id: "conv-b", delivered: true, message_id: "m1" }) },
    });
    expect(selectLinkedConversations(e, SELF)).toEqual([]);
  });
});

describe("selectLinkedConversations — created", () => {
  it("marks a creation with a first message as created AND one message sent", () => {
    const e = entryOf(
      [
        {
          id: "a1",
          blocks: [
            create("t1", { repo_path: "/Users/me/Repos/billing/", title: "Fix invoices", first_message: "Go" }),
          ],
        },
      ],
      { t1: { content: ok({ conversation_id: "conv-new", repo_path: "/x", backend: "claude", started: true, message_id: "m5" }) } },
    );
    expect(selectLinkedConversations(e, SELF)[0]).toMatchObject({
      partnerId: "conv-new",
      created: true,
      sent: 1,
      snapshotTitle: "Fix invoices",
      snapshotRepo: "billing",
      remoteAnchor: { kind: "received", messageId: "m5" },
      localAnchor: { kind: "sentTool", toolUseId: "t1" },
    });
  });

  it("a creation with no first message: created, nothing sent, the folder as its name, no jump target", () => {
    const e = entryOf([{ id: "a1", blocks: [create("t1", { repo_path: "/r/billing" })] }], {
      t1: { content: ok({ conversation_id: "conv-new", repo_path: "/r/billing", backend: "claude", started: false }) },
    });
    expect(selectLinkedConversations(e, SELF)[0]).toMatchObject({
      created: true,
      sent: 0,
      snapshotTitle: "billing",
      remoteAnchor: null,
      localAnchor: { kind: "sentTool", toolUseId: "t1" },
    });
  });

  it("skips a creation with no result yet, or a refused one — no conversation to name", () => {
    const e = entryOf([{ id: "a1", blocks: [create("t1", { repo_path: "/r" }), create("t2", { repo_path: "/nope" })] }], {
      t2: { content: refusal("create_conversation: '/nope' is not a folder"), isError: true },
    });
    expect(selectLinkedConversations(e, SELF)).toEqual([]);
  });
});

describe("selectLinkedConversations — grouping", () => {
  it("groups every exchange per partner and orders partners by their newest one", () => {
    const e = entryOf(
      [
        { id: "a1", blocks: [send("t1", "conv-a")] },
        { id: "u1", user: envelope("conv-b", "mb1", "Billing") },
        { id: "u2", user: envelope("conv-a", "ma2", "Auth, renamed") },
        { id: "a2", blocks: [send("t2", "conv-b")] },
        { id: "u3", user: envelope("conv-a", "ma3", "Auth, renamed") },
      ],
      {
        t1: { content: ok({ conversation_id: "conv-a", delivered: true, message_id: "ma1" }) },
        t2: { content: ok({ conversation_id: "conv-b", delivered: true, message_id: "mb2" }) },
      },
    );
    const list = selectLinkedConversations(e, SELF);
    expect(list.map((l) => l.partnerId)).toEqual(["conv-a", "conv-b"]);
    expect(list[0]).toMatchObject({
      sent: 1,
      received: 2,
      snapshotTitle: "Auth, renamed",
      // Newest exchange with A is its message to us: land on A's send card.
      remoteAnchor: { kind: "sent", messageId: "ma3" },
      localAnchor: { kind: "received", messageId: "ma3" },
    });
    expect(list[1]).toMatchObject({
      sent: 1,
      received: 1,
      snapshotTitle: "Billing",
      remoteAnchor: { kind: "received", messageId: "mb2" },
      localAnchor: { kind: "sentTool", toolUseId: "t2" },
    });
  });
});

describe("linkSummary / failureNote", () => {
  const base = selectLinkedConversations(
    entryOf([{ id: "u1", user: envelope("conv-a", "m1") }]),
    SELF,
  )[0];

  it("says in words what the compact figures stand for", () => {
    expect(linkSummary(base)).toBe("1 message received");
    expect(linkSummary({ ...base, created: true, sent: 3, unconfirmed: 1, received: 2 })).toBe(
      "Created by this conversation · 3 messages sent (1 not confirmed) · 2 messages received",
    );
  });

  it("explains a refusal with its latest reason, and is null when there was none", () => {
    expect(failureNote(base)).toBeNull();
    expect(failureNote({ ...base, failed: 1, failureReason: "Denied" })).toBe(
      "1 message to it was refused: Denied",
    );
    expect(failureNote({ ...base, failed: 2, failureReason: "Denied" })).toBe(
      "2 messages to it were refused. Latest: Denied",
    );
    expect(failureNote({ ...base, failed: 2, failureReason: null })).toBe(
      "2 messages to it were refused.",
    );
  });

  it("clips a long refusal reason to one line", () => {
    const long = "word ".repeat(80);
    const e = entryOf(
      [{ id: "a1", blocks: [send("t1", "conv-b"), send("t2", "conv-b")] }],
      {
        t1: { content: ok({ conversation_id: "conv-b", message_id: "m1" }) },
        t2: { content: refusal(long), isError: true },
      },
    );
    const reason = selectLinkedConversations(e, SELF)[0].failureReason!;
    expect(reason.length).toBeLessThanOrEqual(160);
    expect(reason.endsWith("…")).toBe(true);
    expect(reason).not.toMatch(/\s{2}/);
  });
});

describe("memoizedLinked", () => {
  it("returns the same array while the keyed references are unchanged", () => {
    const e = entryOf([{ id: "u1", user: envelope("conv-a", "m1") }]);
    expect(memoizedLinked("m-same", e)).toBe(memoizedLinked("m-same", e));
  });

  it("keeps the array when an unrelated tool result lands", () => {
    const e1 = entryOf([{ id: "u1", user: envelope("conv-a", "m1") }]);
    const a = memoizedLinked("m-unrelated", e1);
    const e2 = { ...e1, toolResults: { ...e1.toolResults, t9: { toolUseId: "t9", content: "ok", isError: false, parentToolUseId: null } } } as SessionEntry;
    expect(memoizedLinked("m-unrelated", e2)).toBe(a);
  });

  it("sees a send appended to an OPEN turn through toolStartedAt, before any result", () => {
    // `assistant_message` appends the tool_use to the existing turn: the timeline is untouched.
    const e1 = entryOf([{ id: "a1", blocks: [] }]);
    expect(memoizedLinked("m-open", e1)).toEqual([]);
    const turn = e1.turns.a1;
    const e2 = {
      ...e1,
      turns: { a1: { ...turn, blocks: [send("t1", "conv-b")] } },
      toolStartedAt: { t1: 1 },
    } as unknown as SessionEntry;
    expect(memoizedLinked("m-open", e2)[0]).toMatchObject({ partnerId: "conv-b", unconfirmed: 1 });
    // …and its delivery, through toolResults.
    const e3 = {
      ...e2,
      toolResults: { t1: { toolUseId: "t1", content: ok({ conversation_id: "conv-b", message_id: "m1" }), isError: false, parentToolUseId: null } },
    } as unknown as SessionEntry;
    expect(memoizedLinked("m-open", e3)[0]).toMatchObject({ unconfirmed: 0, remoteAnchor: { kind: "received", messageId: "m1" } });
  });

  it("hands a NEW array when only a non-count field moved (the signature covers every field)", () => {
    // Same partner, same counts — only the refusal's reason differs: the "!" tooltip must follow.
    const refusedWith = (reason: string) =>
      entryOf([{ id: "a1", blocks: [send("t1", "conv-b"), send("t2", "conv-b")] }], {
        t1: { content: ok({ conversation_id: "conv-b", message_id: "m1" }) },
        t2: { content: refusal(reason), isError: true },
      });
    const a = memoizedLinked("m-sig", refusedWith("Denied"));
    const b = memoizedLinked("m-sig", refusedWith("Permission denied by the user"));
    expect(b).not.toBe(a);
    expect(b[0].failureReason).toBe("Permission denied by the user");
    // …and a sender's newer name snapshot, counts unchanged.
    const named = (title: string) => entryOf([{ id: "u1", user: envelope("conv-a", "m1", title) }]);
    const c = memoizedLinked("m-sig2", named("Old name"));
    const d = memoizedLinked("m-sig2", named("New name"));
    expect(d).not.toBe(c);
    expect(d[0].snapshotTitle).toBe("New name");
  });

  it("never lists the conversation it is memoised for", () => {
    const e = entryOf([{ id: "u1", user: envelope("m-self", "m1") }]);
    expect(memoizedLinked("m-self", e)).toEqual([]);
  });

  it("clearLinkedCache / clearAllLinkedCache drop the memo — the same entry recomputes afresh", () => {
    const e = entryOf([{ id: "u1", user: envelope("conv-a", "m1") }]);
    const a = memoizedLinked("m-clear", e);
    clearLinkedCache("m-clear");
    const b = memoizedLinked("m-clear", e);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
    clearAllLinkedCache();
    expect(memoizedLinked("m-clear", e)).not.toBe(b);
  });
});
