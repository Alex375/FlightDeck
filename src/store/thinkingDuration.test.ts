import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useConversationStore } from "./conversationStore";
import type { ConversationItem } from "../ipc/client";

// Reflection-time tracking: `thinkingStartedAt` is stamped on the streamingThinking
// empty→non-empty edge (a new thinking block) and frozen into `thinkingDurations`
// (keyed by the block's text) when that block finalizes via `assistant_message`. It must
// handle several thinking blocks per turn (interleaved thinking between tool calls).

const store = () => useConversationStore.getState();
const startedAt = (s: string) => store().sessions[s]?.thinkingStartedAt ?? null;
const durations = (s: string) => store().sessions[s]?.thinkingDurations ?? {};

function assistantThinking(session: string, id: string, text: string) {
  store().applyItem(session, {
    kind: "assistant_message",
    id,
    parent_tool_use_id: null,
    blocks: [{ type: "thinking", text }],
  } as ConversationItem);
}

describe("thinking reflection time", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stamps thinkingStartedAt on the first thinking delta of a block", () => {
    const s = "think-start";
    store().ensureSession(s);
    expect(startedAt(s)).toBeNull();
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "let me think");
    expect(startedAt(s)).toBe(1_000_000);
  });

  it("does NOT re-stamp on later deltas of the same block", () => {
    const s = "think-noreset";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "step one ");
    vi.setSystemTime(new Date(1_003_000));
    store().appendThinking(s, "m1", "step two");
    expect(startedAt(s)).toBe(1_000_000);
  });

  it("freezes the block's duration (keyed by text) and clears the start on finalize", () => {
    const s = "think-freeze";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "deep thought");
    vi.setSystemTime(new Date(1_008_000));
    assistantThinking(s, "m1", "deep thought");
    expect(durations(s)["deep thought"]).toBe(8_000);
    expect(startedAt(s)).toBeNull();
  });

  it("tracks two interleaved thinking blocks independently", () => {
    const s = "think-interleaved";
    store().ensureSession(s);
    // First block: 5s.
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "first block");
    vi.setSystemTime(new Date(1_005_000));
    assistantThinking(s, "m1", "first block");
    // ...tool call happens... then a second thinking block on a new message: 3s.
    vi.setSystemTime(new Date(1_010_000));
    store().appendThinking(s, "m2", "second block");
    vi.setSystemTime(new Date(1_013_000));
    assistantThinking(s, "m2", "second block");
    expect(durations(s)["first block"]).toBe(5_000);
    expect(durations(s)["second block"]).toBe(3_000);
    expect(startedAt(s)).toBeNull();
  });

  it("clears thinkingStartedAt when the turn ends (busy true→false)", () => {
    const s = "think-turnend";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    // Turn goes busy, thinking starts, then the turn ends WITHOUT finalizing the block
    // (e.g. interrupted) — the stamp must not leak into the next turn.
    store().applyState(s, baseState(true));
    store().appendThinking(s, "m1", "interrupted mid-thought");
    expect(startedAt(s)).toBe(1_000_000);
    store().applyState(s, baseState(false));
    expect(startedAt(s)).toBeNull();
  });

  it("records NO duration for a block finalized without a preceding delta (hydrated from disk)", () => {
    // Symmetric to toolDuration's disk-reload test: a resumed/merged transcript delivers
    // the thinking block straight as an `assistant_message`, with no streaming delta, so
    // `thinkingStartedAt` stays null and the freeze guard (`thinkingStartedAt != null`)
    // must record NOTHING — never `Date.now() - null`.
    const s = "think-nostart";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    assistantThinking(s, "m1", "hydrated thought");
    expect(durations(s)["hydrated thought"]).toBeUndefined();
    expect(startedAt(s)).toBeNull();
  });

  it("two blocks with IDENTICAL text collide (known lossy limit of text-keying)", () => {
    // `thinkingDurations` is keyed by the block's TEXT (the only stable handle the renderer
    // has — a block id is deliberately NOT threaded through grouping). Two blocks whose text
    // is byte-identical therefore share the key: the second freeze overwrites the first, and
    // BOTH rendered blocks read the second duration. This pins that accepted behavior so a
    // future change to the keying is a conscious decision, not a silent regression.
    const s = "think-collide";
    store().ensureSession(s);
    vi.setSystemTime(new Date(1_000_000));
    store().appendThinking(s, "m1", "Let me check.");
    vi.setSystemTime(new Date(1_002_000)); // first block: 2s
    assistantThinking(s, "m1", "Let me check.");
    expect(durations(s)["Let me check."]).toBe(2_000);
    vi.setSystemTime(new Date(1_010_000));
    store().appendThinking(s, "m2", "Let me check.");
    vi.setSystemTime(new Date(1_017_000)); // second block: 7s → overwrites the 2s
    assistantThinking(s, "m2", "Let me check.");
    expect(durations(s)["Let me check."]).toBe(7_000);
  });

  it("stamps the start via the out-of-band thinking_delta path in applyItem", () => {
    // Deltas normally arrive rAF-coalesced through appendThinking; applyItem carries a
    // SECOND copy of the empty→non-empty stamp for out-of-band delivery. Exercise it
    // directly so the duplicated edge guard can't silently drift.
    const s = "think-oob";
    store().ensureSession(s);
    store().applyItem(s, {
      kind: "message_started",
      id: "m1",
      role: "assistant",
      parent_tool_use_id: null,
    } as ConversationItem);
    expect(startedAt(s)).toBeNull(); // opening the turn does not stamp
    vi.setSystemTime(new Date(1_000_000));
    store().applyItem(s, {
      kind: "thinking_delta",
      message_id: "m1",
      text: "out of band",
    } as ConversationItem);
    expect(startedAt(s)).toBe(1_000_000);
    // A later delta of the SAME block does not re-stamp.
    vi.setSystemTime(new Date(1_004_000));
    store().applyItem(s, {
      kind: "thinking_delta",
      message_id: "m1",
      text: " more",
    } as ConversationItem);
    expect(startedAt(s)).toBe(1_000_000);
  });
});

function baseState(busy: boolean) {
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
