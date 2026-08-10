import { describe, it, expect, beforeEach } from "vitest";
import { useConversationStore } from "./conversationStore";

// `removeLastUserTurn` takes back the optimistic bubble of a message the BINARY
// confirmed it dropped from its queue (`cancel_last_user_message`). It is the second
// half of "stop takes the message back": the first attempt at this feature was reverted
// because removing only the UI turn let the message come back on the next history
// reload — so this action is called ONLY after that confirmation, and must undo exactly
// what `addUserTurn` did, nothing more.

const store = () => useConversationStore.getState();

function userTurnIds(session: string) {
  const entry = useConversationStore.getState().sessions[session];
  return entry.timeline
    .filter((e) => e.kind === "turn" && entry.turns[e.id]?.role === "user")
    .map((e) => (e as { id: string }).id);
}

describe("removeLastUserTurn", () => {
  beforeEach(() => {
    useConversationStore.setState({ sessions: {} });
  });

  it("removes the last user turn and forgets its content", () => {
    store().addUserTurn("s1", "first");
    store().addUserTurn("s1", "oops, wrong prompt");
    expect(userTurnIds("s1")).toHaveLength(2);

    store().removeLastUserTurn("s1");

    const entry = useConversationStore.getState().sessions.s1;
    expect(userTurnIds("s1")).toHaveLength(1);
    expect(entry.timeline).toHaveLength(1);
    // The turn object goes too — a dangling entry would keep the text addressable.
    expect(Object.values(entry.turns).map((t) => t.streamingText)).toEqual(["first"]);
  });

  it("keeps the replay anchor inside the shortened timeline", () => {
    // addUserTurn pushes the anchor PAST the turn it just added, so undoing the turn
    // without pulling the anchor back would leave it beyond the end — and a later
    // remote echo would splice past it.
    store().addUserTurn("s2", "only message");
    const before = useConversationStore.getState().sessions.s2;
    expect(before.replayAnchor).toBe(1);

    store().removeLastUserTurn("s2");

    const after = useConversationStore.getState().sessions.s2;
    expect(after.replayAnchor).toBeLessThanOrEqual(after.timeline.length);
  });

  it("removes one specific queued message without touching the others", () => {
    // The pending badge drops THAT message, not "the last one" — a second message may
    // have been queued behind it in the meantime.
    const first = store().addUserTurn("s4", "first", true);
    store().addUserTurn("s4", "second", true);

    store().removeUserTurn("s4", first);

    const entry = useConversationStore.getState().sessions.s4;
    expect(Object.values(entry.turns).map((t) => t.streamingText)).toEqual(["second"]);
  });

  it("carries the wire uuid that makes a queued message addressable", () => {
    // Without it there is no way to name the message in the binary's queue, and the UI
    // must not offer to remove it.
    const id = store().addUserTurn("s5", "queued one", true);
    expect(useConversationStore.getState().sessions.s5.turns[id].wireUuid).toBeUndefined();

    store().setTurnWireUuid("s5", id, "uuid-42");
    expect(useConversationStore.getState().sessions.s5.turns[id].wireUuid).toBe("uuid-42");
  });

  it("attaching a uuid to a turn that is already gone is a no-op", () => {
    // The send can answer after the turn was cancelled or rewound away.
    const id = store().addUserTurn("s6", "gone", true);
    store().removeUserTurn("s6", id);
    expect(() => store().setTurnWireUuid("s6", id, "uuid-x")).not.toThrow();
    expect(useConversationStore.getState().sessions.s6.turns[id]).toBeUndefined();
  });

  it("is a no-op when there is no user turn to take back", () => {
    store().addUserTurn("s3", "sent");
    store().removeLastUserTurn("s3");
    // A second stop (the message was already dropped) must not eat anything else.
    store().removeLastUserTurn("s3");
    expect(userTurnIds("s3")).toHaveLength(0);
    expect(useConversationStore.getState().sessions.s3.timeline).toHaveLength(0);
  });
});
