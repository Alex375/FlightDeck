import { describe, it, expect, beforeEach } from "vitest";
import { useConversationStore } from "./conversationStore";

// `removeUserTurn` takes back the optimistic bubble of a message the BINARY confirmed it
// dropped from its queue (`cancel_queued_message`, from the pending badge). An earlier
// attempt at this feature was reverted because removing only the UI turn let the message
// come back on the next history reload — so it is called ONLY after that confirmation,
// and must undo exactly what `addUserTurn` did, nothing more.

const store = () => useConversationStore.getState();

describe("cancelling a queued user turn", () => {
  beforeEach(() => {
    useConversationStore.setState({ sessions: {} });
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

});
