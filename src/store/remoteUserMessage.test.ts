import { describe, it, expect, beforeEach } from "vitest";
import { useConversationStore } from "./conversationStore";
import type { ConversationItem } from "../ipc/client";

// The live path now emits `user_message` items for remote-originated turns (typed on
// the phone/web while Remote Control is on), replayed on the stream by
// `--replay-user-messages`. Our OWN turns are suppressed in the Rust core (by the uuid
// we stamped), so only remote turns / history replays reach the reducer. These tests
// pin it: a remote turn is rendered, and a re-delivery dedupes by uuid.

const store = () => useConversationStore.getState();

/** A user_message item. `replay` = true for a LIVE remote echo (spliced at the anchor),
 *  false for a chronological history restore (appended). */
function userMessage(session: string, id: string, text: string, replay = true) {
  store().applyItem(session, {
    kind: "user_message",
    id,
    text,
    parent_tool_use_id: null,
    replay,
  } as ConversationItem);
}

function messageStarted(session: string, id: string) {
  store().applyItem(session, {
    kind: "message_started",
    id,
    role: "assistant",
    parent_tool_use_id: null,
  } as ConversationItem);
}

function turnResult(session: string) {
  store().applyItem(session, {
    kind: "turn_result",
    subtype: "success",
    is_error: false,
    result: null,
    api_error_status: null,
    total_cost_usd: null,
    num_turns: null,
    duration_ms: null,
  } as ConversationItem);
}

/** Ordered ids of `turn`-kind timeline entries (drops turn_result footers). */
const turnOrder = (session: string) =>
  (store().sessions[session]?.timeline ?? [])
    .filter((e) => e.kind === "turn")
    .map((e) => e.id);

const timelineIds = (session: string) =>
  (store().sessions[session]?.timeline ?? [])
    .filter((e) => e.kind === "turn")
    .map((e) => e.id);

const textOf = (session: string, id: string) =>
  store().sessions[session]?.turns[id]?.streamingText;

describe("remote user_message rendering", () => {
  beforeEach(() => {
    // Fresh store per test.
    useConversationStore.setState({ sessions: {} } as never);
  });

  it("renders a remote-originated user turn (keyed by uuid)", () => {
    const s = "conv-1";
    store().ensureSession(s);
    userMessage(s, "u-remote", "hello from the phone");
    expect(timelineIds(s)).toEqual(["u-remote"]);
    expect(textOf(s, "u-remote")).toBe("hello from the phone");
  });

  it("dedupes a re-delivered user_message by id", () => {
    const s = "conv-2";
    store().ensureSession(s);
    userMessage(s, "u-1", "hi there");
    userMessage(s, "u-1", "hi there");
    expect(timelineIds(s)).toEqual(["u-1"]);
  });

  it("renders a remote turn even when it repeats a local message's text", () => {
    // The core suppresses OUR echoes by uuid, so the front must NOT text-dedupe: a
    // genuine remote turn identical to a local one (different uuid) must still show.
    const s = "conv-3";
    store().ensureSession(s);
    store().addUserTurn(s, "same text");
    userMessage(s, "u-remote-dup", "same text");
    expect(timelineIds(s).length).toBe(2);
    expect(textOf(s, "u-remote-dup")).toBe("same text");
  });

  it("orders a remote turn BEFORE its response even when the reply streamed first", () => {
    // The replay of a phone-typed message can arrive AFTER its answer already began
    // streaming (the reported bug). It must still land before that answer.
    const s = "conv-order";
    store().ensureSession(s);
    // Turn 1 sets the anchor to the end of the timeline (via turn_result).
    messageStarted(s, "asst-1");
    turnResult(s);
    // Turn 2 (remote): the assistant reply streams FIRST, then the phone message
    // arrives out of order.
    messageStarted(s, "asst-2");
    userMessage(s, "remote-2", "question typed on the phone");
    turnResult(s);
    const order = turnOrder(s);
    // The remote turn precedes the reply it triggered (asst-2), not the reverse.
    expect(order).toEqual(["asst-1", "remote-2", "asst-2"]);
  });

  it("keeps several queued remote turns in their arrival order", () => {
    const s = "conv-order2";
    store().ensureSession(s);
    messageStarted(s, "asst-x");
    turnResult(s); // anchor at end
    // Two remote messages arrive before the next reply starts streaming.
    messageStarted(s, "asst-y");
    userMessage(s, "remote-a", "first");
    userMessage(s, "remote-b", "second");
    expect(turnOrder(s)).toEqual(["asst-x", "remote-a", "remote-b", "asst-y"]);
  });

  // REGRESSION (adversarial review): the anchored splice must NOT reorder a resumed
  // transcript. History items (`replay:false`) carry NO turn_result, so the anchor is
  // never re-armed — they MUST append chronologically, not bunch all user turns above
  // the replies.
  it("appends history (replay:false) in chronological order — no scramble on resume", () => {
    const s = "conv-resume";
    store().ensureSession(s);
    // Simulate loadSessionHistory's applyItem sequence for a 3-turn transcript
    // (UserMessage/AssistantMessage interleaved, NO turn_result).
    userMessage(s, "u1", "q1", false);
    messageStarted(s, "a1");
    userMessage(s, "u2", "q2", false);
    messageStarted(s, "a2");
    userMessage(s, "u3", "q3", false);
    messageStarted(s, "a3");
    expect(turnOrder(s)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
  });

  it("keeps the mid-turn flag of a message restored from a queued injection", () => {
    // A message another conversation sent while this one worked comes back from the
    // transcript's queued_command with `mid_turn` — clean output needs the durable flag.
    const s = "conv-midturn";
    store().ensureSession(s);
    store().applyItem(s, {
      kind: "user_message",
      id: "q1",
      text: "<flightdeck-message>\n<body>\nhi\n</body>\n</flightdeck-message>",
      parent_tool_use_id: null,
      replay: false,
      mid_turn: true,
    } as ConversationItem);
    userMessage(s, "u2", "plain prompt", false);
    expect(store().sessions[s]?.turns.q1?.injectedMidTurn).toBe(true);
    expect(store().sessions[s]?.turns.u2?.injectedMidTurn).toBe(false);
  });

  it("first LIVE remote turn after a resume lands at the END of restored history", () => {
    const s = "conv-resume2";
    store().ensureSession(s);
    // Restored history (no turn_result), then re-anchor as loadConversationHistory does.
    userMessage(s, "u1", "q1", false);
    messageStarted(s, "a1");
    store().reanchorReplay(s);
    // A phone message now arrives while the next reply streams.
    messageStarted(s, "a2");
    userMessage(s, "remote", "from the phone", true);
    // It sits after the restored history, before the new reply — not above everything.
    expect(turnOrder(s)).toEqual(["u1", "a1", "remote", "a2"]);
  });
});
