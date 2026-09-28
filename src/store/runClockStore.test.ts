import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem } from "../ipc/client";
import { runFooterFor, liveRunStart } from "../agent/runClock";
import { useConversationStore } from "./conversationStore";

// The run clock as the store drives it from the live events: the user's send, the busy
// edges of `session_state`, each `turn_result` (whose store id the footer is keyed by)
// and the background-task snapshots the event router forwards with `noteTask`.

const store = () => useConversationStore.getState();
const entry = (s: string) => useConversationStore.getState().sessions[s];

function setBusy(s: string, busy: boolean) {
  store().applyState(s, { ...entry(s).state, busy });
}

function result(durationApiMs: number | null): ConversationItem {
  return {
    kind: "turn_result",
    subtype: "success",
    is_error: false,
    result: null,
    api_error_status: null,
    total_cost_usd: null,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: durationApiMs,
    ttft_ms: null,
  };
}

/** The store id of the latest `turn_result` in the timeline. */
function lastResultId(s: string): string {
  const t = entry(s).timeline.filter((e) => e.kind === "turn_result");
  return t[t.length - 1].id;
}

describe("run clock in the conversation store", () => {
  beforeEach(() => {
    useConversationStore.setState({ sessions: {} });
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times a prompt from the Enter across the follow-up turns its background work triggers", () => {
    store().addUserTurn("c1", "go", false);
    vi.setSystemTime(100);
    setBusy("c1", true);
    store().noteTask("c1", "bash", true);
    vi.setSystemTime(6000);
    store().applyItem("c1", result(4000));
    setBusy("c1", false);
    const main = lastResultId("c1");
    expect(runFooterFor(entry("c1").runClock, main)).toMatchObject({
      mainMs: 6000,
      backgroundSince: 0,
      backgroundCount: 1,
    });

    // Progress ticks of a running task leave the store untouched.
    const before = entry("c1");
    store().noteTask("c1", "bash", true);
    expect(entry("c1")).toBe(before);

    // The Bash reports back: the CLI's follow-up turn keeps the Enter as its start.
    vi.setSystemTime(40_000);
    store().noteTask("c1", "bash", false);
    vi.setSystemTime(41_000);
    setBusy("c1", true);
    expect(liveRunStart(entry("c1").runClock)).toBe(0);
    vi.setSystemTime(43_000);
    store().applyItem("c1", result(900));
    setBusy("c1", false);

    const followUp = lastResultId("c1");
    expect(runFooterFor(entry("c1").runClock, main)).toBe("hidden");
    expect(runFooterFor(entry("c1").runClock, followUp)).toMatchObject({
      mainMs: 6000,
      totalMs: 43_000,
      extended: true,
      modelMs: 4900,
    });
  });

  it("keeps a message sent mid-turn in the run in flight", () => {
    store().addUserTurn("c2", "first", false);
    setBusy("c2", true);
    vi.setSystemTime(5000);
    store().addUserTurn("c2", "and also", true);
    expect(entry("c2").runClock.runs).toHaveLength(1);
  });

  it("ends a run whose process ended", () => {
    store().addUserTurn("c3", "go", false);
    setBusy("c3", true);
    store().noteTask("c3", "bash", true);
    store().applyItem("c3", result(100));
    setBusy("c3", false);
    vi.setSystemTime(9000);
    store().applyState("c3", { ...entry("c3").state, ended: true });
    expect(runFooterFor(entry("c3").runClock, lastResultId("c3"))).toMatchObject({
      totalMs: 9000,
      backgroundSince: null,
    });
  });

  it("ignores a task snapshot for a conversation it does not hold", () => {
    const before = useConversationStore.getState();
    store().noteTask("nope", "bash", true);
    expect(useConversationStore.getState()).toBe(before);
  });
});
