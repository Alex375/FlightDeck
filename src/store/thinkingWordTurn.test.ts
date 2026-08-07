import { describe, it, expect } from "vitest";
import { useConversationStore } from "./conversationStore";
import { describeActivity } from "./activity";
import { THINKING_ACCRUAL_CAP_MS } from "./thinkingWords";
import type { SessionStatePayload } from "./types";

// The store tracks `turnCount` (bumped on each busy false→true edge). It re-seeds the playful
// "Thinking…" word so it changes on every new turn; the TIER is driven by cumulative thinking
// time (see thinkingWords.ts), not by this count. The word itself is computed live in the render
// hook, not stored — so here we only assert the counter's edge behaviour.

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

const entry = (s: string) => store().sessions[s];

describe("turnCount (playful word per-turn seed)", () => {
  it("bumps on each busy false→true edge", () => {
    const s = "twc-count";
    store().ensureSession(s);
    expect(entry(s).turnCount).toBe(0);
    for (let t = 1; t <= 4; t++) {
      store().applyState(s, state(true));
      store().applyState(s, state(false));
      expect(entry(s).turnCount).toBe(t);
    }
  });

  it("does NOT bump on a mid-turn busy:true re-emit", () => {
    const s = "twc-reemit";
    store().ensureSession(s);
    store().applyState(s, state(true));
    store().applyState(s, state(true)); // system/init/status re-fires busy:true same turn
    expect(entry(s).turnCount).toBe(1);
  });

  it("leaves the generic activity as the plain 'Thinking…' at the store level (word added in the hook)", () => {
    const s = "twc-generic";
    store().ensureSession(s);
    store().applyState(s, state(true));
    expect(describeActivity(entry(s))).toBe("Thinking…");
  });
});

describe("accrueThinking (spinner clock)", () => {
  it("opens on enter, accrues incrementally, seals on leave", () => {
    const s = "acc-1";
    store().ensureSession(s);
    expect(entry(s).thinkingMs).toBe(0);
    store().accrueThinking(s, true, 1000); // enter → open, nothing credited yet
    expect(entry(s).thinkingSince).toBe(1000);
    expect(entry(s).thinkingMs).toBe(0);
    store().accrueThinking(s, true, 1400); // +400 (< cap), advance the sample point
    expect(entry(s).thinkingMs).toBe(400);
    expect(entry(s).thinkingSince).toBe(1400);
    store().accrueThinking(s, false, 1600); // leave → seal +200
    expect(entry(s).thinkingMs).toBe(600);
    expect(entry(s).thinkingSince).toBeNull();
  });

  it("caps each sample so a frozen ticker (system sleep) can't inject a huge gap", () => {
    const s = "acc-cap";
    store().ensureSession(s);
    store().accrueThinking(s, true, 0); // open at 0
    store().accrueThinking(s, true, 9_999_999); // huge wall-clock jump → capped
    expect(entry(s).thinkingMs).toBe(THINKING_ACCRUAL_CAP_MS);
  });

  it("is a no-op (same entry ref, no re-render) while not thinking with nothing open", () => {
    const s = "acc-2";
    store().ensureSession(s);
    const before = entry(s);
    store().accrueThinking(s, false, 1000);
    expect(entry(s)).toBe(before);
  });
});
