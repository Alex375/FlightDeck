import { describe, it, expect, vi, afterEach } from "vitest";
import { useConversationStore } from "./conversationStore";
import type { SessionStatePayload } from "./types";

// The working line's "Compacting conversation…" counter runs on its own clock, stamped on the
// `activity` → "compacting" edge (the CLI's `system/status`), never on a re-emit of it.

const store = () => useConversationStore.getState();

function state(activity: string | null): SessionStatePayload {
  return {
    busy: true,
    session_id: null,
    cwd: null,
    model: null,
    permission_mode: null,
    output_style: null,
    effort: null,
    ultracode: false,
    ultracode_available: null,
    activity,
    awaiting_permission: false,
    retry: null,
    link: null,
    ended: false,
    context_tokens: null,
    context_window: null,
    context_usage: null,
    rate_limit: null,
  };
}

const since = (s: string) => store().sessions[s].compactingSince;

afterEach(() => vi.useRealTimers());

describe("compactingSince", () => {
  it("stamps on the edge, holds across re-emits, clears when it ends", () => {
    vi.useFakeTimers();
    const s = "compact-clock";
    store().ensureSession(s);
    vi.setSystemTime(1_000);
    store().applyState(s, state("requesting"));
    expect(since(s)).toBeNull();
    vi.setSystemTime(2_000);
    store().applyState(s, state("compacting"));
    expect(since(s)).toBe(2_000);
    vi.setSystemTime(9_000);
    store().applyState(s, state("compacting")); // a re-emit mid-compaction
    expect(since(s)).toBe(2_000);
    store().applyState(s, state(null));
    expect(since(s)).toBeNull();
  });

  it("is cleared with the session", () => {
    const s = "compact-clock-clear";
    store().ensureSession(s);
    store().applyState(s, state("compacting"));
    expect(since(s)).not.toBeNull();
    store().clearState(s);
    expect(since(s)).toBeNull();
  });
});
