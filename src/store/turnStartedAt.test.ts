import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useConversationStore } from "./conversationStore";
import type { ConversationItem } from "../ipc/client";
import type { SessionStatePayload } from "./types";

// `turnStartedAt` stamps the wall-clock start of the in-flight turn so the working
// indicator can show a live elapsed counter. It must be edge-gated: set on the busy
// false→true transition, cleared on true→false — and crucially NOT reset when a state
// event re-emits busy:true mid-turn (system/init/status re-fire each turn), otherwise
// the counter would jump back to 0 partway through a long turn.

const store = () => useConversationStore.getState();

function state(busy: boolean): SessionStatePayload {
  return {
    busy,
    session_id: null,
    cwd: null,
    model: null,
    permission_mode: null,
    effort: null,
    ultracode: false,
    activity: null,
    awaiting_permission: false,
  retry: null,
    ended: false,
    context_tokens: null,
    context_window: null,
    rate_limit: null,
  };
}

const startedAt = (session: string) => store().sessions[session]?.turnStartedAt ?? null;
const thinkingStartedAt = (session: string) =>
  store().sessions[session]?.thinkingStartedAt ?? null;
const toolStartedAt = (session: string) => store().sessions[session]?.toolStartedAt ?? {};

describe("turnStartedAt", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stamps Date.now() on the busy false→true edge", () => {
    const s = "tsa-edge";
    store().ensureSession(s);
    expect(startedAt(s)).toBeNull();
    vi.setSystemTime(new Date(1_000_000));
    store().applyState(s, state(true));
    expect(startedAt(s)).toBe(1_000_000);
  });

  it("does NOT reset while busy stays true (mid-turn re-emit)", () => {
    const s = "tsa-reemit";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().applyState(s, state(true));
    // system/init / status re-fires busy:true later in the SAME turn.
    vi.setSystemTime(new Date(1_050_000));
    store().applyState(s, state(true));
    expect(startedAt(s)).toBe(1_000_000);
  });

  it("clears on the busy true→false edge", () => {
    const s = "tsa-clear";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().applyState(s, state(true));
    store().applyState(s, state(false));
    expect(startedAt(s)).toBeNull();
  });

  it("re-stamps a fresh start for the next turn", () => {
    const s = "tsa-next";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().applyState(s, state(true));
    store().applyState(s, state(false));
    vi.setSystemTime(new Date(2_000_000));
    store().applyState(s, state(true));
    expect(startedAt(s)).toBe(2_000_000);
  });

  it("clearState drops ALL three timing stamps (turn, thinking, tool)", () => {
    // Turning the stream off must not leak a stale start into the next spawn — a live
    // counter would otherwise resume from an old timestamp. clearState resets all three:
    // turnStartedAt, thinkingStartedAt and toolStartedAt.
    const s = "tsa-clearstate";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().applyState(s, state(true)); // turnStartedAt
    store().appendThinking(s, "m1", "mid-thought"); // thinkingStartedAt
    store().applyItem(s, {
      kind: "assistant_message",
      id: "m1",
      parent_tool_use_id: null,
      blocks: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: {} }],
    } as ConversationItem); // toolStartedAt["toolu_x"]
    expect(startedAt(s)).toBe(1_000_000);
    expect(thinkingStartedAt(s)).not.toBeNull();
    expect(toolStartedAt(s)["toolu_x"]).toBeDefined();
    store().clearState(s);
    expect(startedAt(s)).toBeNull();
    expect(thinkingStartedAt(s)).toBeNull();
    expect(toolStartedAt(s)).toEqual({});
  });
});
