import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the IPC surface — we assert whether/how the summary command is fired.
vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return { commands: { generateMessageSummary: vi.fn(() => ok()) } };
});

import { commands } from "../ipc/client";
import {
  summaryPreview,
  cleanSummary,
  isTrivialToSummarize,
  triggerLastMessageSummary,
  useLastMessageSummaryStore,
  summaryKey,
  cacheSummary,
} from "./lastMessageSummary";

const genMock = commands.generateMessageSummary as unknown as ReturnType<typeof vi.fn>;
const valueOf = (id: string) => useLastMessageSummaryStore.getState().byConv[id];
const cacheOf = (id: string) => useLastMessageSummaryStore.getState().cache[id] ?? {};
const cachedFor = (id: string, text: string) => cacheOf(id)[summaryKey(text)];

beforeEach(() => {
  genMock.mockClear();
  useLastMessageSummaryStore.getState().clearAll();
});

describe("summaryPreview", () => {
  it("takes the first line, collapses whitespace, truncates with ellipsis", () => {
    expect(summaryPreview("Fix   the  bug")).toBe("Fix the bug");
    expect(summaryPreview("first line\nsecond line")).toBe("first line");
    expect(summaryPreview("x".repeat(80), 10)).toBe("xxxxxxxxxx…");
  });
});

describe("cleanSummary", () => {
  it("trims and peels wrapping quotes, WITHOUT ever truncating (no ellipsis on the summary)", () => {
    expect(cleanSummary('"Fix the login crash"')).toBe("Fix the login crash");
    expect(cleanSummary("  «  Refactor  »  ")).toBe("Refactor");
    // A longer-than-a-line summary is returned in full — the card wraps it, never clips it.
    const long = "Implement live syncing of remote conversations";
    expect(cleanSummary(long)).toBe(long);
    expect(cleanSummary(long)).not.toContain("…");
  });
});

describe("isTrivialToSummarize", () => {
  it("is trivial for slash commands and short single-line messages", () => {
    expect(isTrivialToSummarize("/build-app")).toBe(true);
    expect(isTrivialToSummarize("thanks")).toBe(true);
    expect(isTrivialToSummarize("")).toBe(true);
  });
  it("is NOT trivial for long or multi-line messages (Haiku earns its keep)", () => {
    expect(isTrivialToSummarize("a".repeat(60))).toBe(false);
    expect(isTrivialToSummarize("line 1\nline 2")).toBe(false);
  });
});

describe("triggerLastMessageSummary", () => {
  it("shows the truncation instantly and fires Haiku for a long message with a handle", () => {
    const msg = "x".repeat(80);
    triggerLastMessageSummary("c1", "session-1", msg);
    expect(valueOf("c1")).toBe(summaryPreview(msg)); // instant preview
    expect(genMock).toHaveBeenCalledTimes(1);
    expect(genMock).toHaveBeenCalledWith("session-1", msg, 1);
  });

  it("skips the Haiku call for a trivial message (preview is the summary)", () => {
    triggerLastMessageSummary("c1", "session-1", "/land");
    expect(valueOf("c1")).toBe("/land");
    expect(genMock).not.toHaveBeenCalled();
  });

  it("skips the Haiku call when there is no live session (only the preview shows)", () => {
    const msg = "a message long enough for a real Haiku summary";
    triggerLastMessageSummary("c1", null, msg);
    expect(valueOf("c1")).toBe(summaryPreview(msg));
    expect(genMock).not.toHaveBeenCalled();
  });

  it("bumps the seq on each send so a superseded response can be dropped", () => {
    triggerLastMessageSummary("c1", "session-1", "first long message to summarize via the small model");
    triggerLastMessageSummary("c1", "session-1", "second long message to summarize via the small model");
    expect(genMock).toHaveBeenLastCalledWith("session-1", expect.stringContaining("second"), 2);
  });
});

describe("apply (seq gate)", () => {
  it("applies a summary whose seq matches the conversation's latest message", () => {
    triggerLastMessageSummary("c1", "session-1", "long message to trigger a Haiku generation");
    useLastMessageSummaryStore.getState().apply("c1", "Fresh summary", 1);
    expect(valueOf("c1")).toBe("Fresh summary");
  });

  it("drops a stale (superseded) response — a newer message advanced the seq", () => {
    const msg2 = "second long message to summarize via the small model";
    triggerLastMessageSummary("c1", "session-1", "first long message to summarize via the small model");
    triggerLastMessageSummary("c1", "session-1", msg2);
    // The Haiku for message #1 (seq 1) lands late — it must NOT clobber #2's preview.
    useLastMessageSummaryStore.getState().apply("c1", "Stale summary of #1", 1);
    expect(valueOf("c1")).toBe(summaryPreview(msg2));
    // The Haiku for #2 (seq 2) applies.
    useLastMessageSummaryStore.getState().apply("c1", "Summary of #2", 2);
    expect(valueOf("c1")).toBe("Summary of #2");
  });

  it("clear() forgets the conversation and resets its seq", () => {
    triggerLastMessageSummary("c1", "session-1", "long message to summarize");
    useLastMessageSummaryStore.getState().clear("c1");
    expect(valueOf("c1")).toBeUndefined();
    // After clear, the next send starts a fresh seq at 1 (a late seq-2 from before is dropped).
    useLastMessageSummaryStore.getState().apply("c1", "ghost", 2);
    expect(valueOf("c1")).toBeUndefined();
  });
});

describe("summaryKey", () => {
  it("is stable per text and differs between messages", () => {
    expect(summaryKey("hello")).toBe(summaryKey("hello"));
    expect(summaryKey("hello")).not.toBe(summaryKey("hello "));
  });

  it("never produces an all-digit key — that would reorder as an array index and break FIFO", () => {
    // Object key ordering puts integer-like keys FIRST, in numeric order, which would
    // silently corrupt the oldest-first eviction below.
    for (let i = 0; i < 500; i++) expect(/^\d+$/.test(summaryKey("msg-" + i))).toBe(false);
  });
});

describe("cacheSummary (pure, oldest-first eviction)", () => {
  it("adds an entry without touching the other conversations", () => {
    const next = cacheSummary({ other: { hX: "keep" } }, "c1", "hA", "summary A");
    expect(next.c1).toEqual({ hA: "summary A" });
    expect(next.other).toEqual({ hX: "keep" });
  });

  it("returns the SAME cache object when nothing changes (no needless write/re-render)", () => {
    const cache = { c1: { hA: "summary A" } };
    expect(cacheSummary(cache, "c1", "hA", "summary A")).toBe(cache);
  });

  it("evicts the OLDEST entries past the cap", () => {
    let cache = {};
    for (let i = 0; i < 205; i++) cache = cacheSummary(cache, "c1", "h" + i, "s" + i);
    const keys = Object.keys((cache as Record<string, Record<string, string>>).c1);
    expect(keys).toHaveLength(200);
    expect(keys[0]).toBe("h5"); // h0…h4 evicted
    expect(keys[keys.length - 1]).toBe("h204");
  });

  it("re-inserting an existing message refreshes its recency", () => {
    let cache = cacheSummary({}, "c1", "hA", "first");
    cache = cacheSummary(cache, "c1", "hB", "second");
    cache = cacheSummary(cache, "c1", "hA", "first again");
    expect(Object.keys(cache.c1)).toEqual(["hB", "hA"]);
  });
});

describe("per-message summary cache (what the minimap reads)", () => {
  it("files an arriving summary under the message it was generated for", () => {
    const msg = "a long message that earns a real Haiku summary";
    triggerLastMessageSummary("c1", "session-1", msg);
    useLastMessageSummaryStore.getState().apply("c1", "Real summary", 1);
    expect(cachedFor("c1", msg)).toBe("Real summary");
  });

  it("still caches a summary that arrives LATE, after a newer message superseded it", () => {
    const first = "first long message that earns a real Haiku summary";
    const second = "second long message that earns a real Haiku summary";
    triggerLastMessageSummary("c1", "session-1", first);
    triggerLastMessageSummary("c1", "session-1", second);
    // Message #1's summary lands after #2 was sent. It is stale for the "last message"
    // line, but it is still the correct summary for #1 — the minimap shows every message.
    useLastMessageSummaryStore.getState().apply("c1", "Summary of #1", 1);
    expect(valueOf("c1")).toBe(summaryPreview(second)); // display untouched
    expect(cachedFor("c1", first)).toBe("Summary of #1"); // …but filed
  });

  it("cleans the summary before caching it (quotes the small model sometimes adds)", () => {
    const msg = "another long message that earns a real Haiku summary";
    triggerLastMessageSummary("c1", "session-1", msg);
    useLastMessageSummaryStore.getState().apply("c1", '  "Quoted summary"  ', 1);
    expect(cachedFor("c1", msg)).toBe("Quoted summary");
  });

  it("survives a reload — the whole point of persisting it", () => {
    const msg = "a long message whose summary must outlive this run";
    triggerLastMessageSummary("c1", "session-1", msg);
    useLastMessageSummaryStore.getState().apply("c1", "Persisted summary", 1);
    const raw = localStorage.getItem("tosse:msgsummaries");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).c1[summaryKey(msg)]).toBe("Persisted summary");
  });

  it("clear() drops the conversation's cached summaries, from storage too", () => {
    const msg = "a long message that earns a real Haiku summary";
    triggerLastMessageSummary("c1", "session-1", msg);
    useLastMessageSummaryStore.getState().apply("c1", "Doomed summary", 1);
    useLastMessageSummaryStore.getState().clear("c1");
    expect(cachedFor("c1", msg)).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("tosse:msgsummaries") as string).c1).toBeUndefined();
  });

  it("does not cache anything for a message that was never sent for generation", () => {
    // A summary for an unknown seq (nothing pending) has no message to be filed under.
    useLastMessageSummaryStore.getState().apply("c1", "Orphan summary", 99);
    expect(cacheOf("c1")).toEqual({});
  });
});
