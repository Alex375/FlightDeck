import { describe, it, expect } from "vitest";
import {
  selectUserMessageHistory,
  memoizedUserMessageHistory,
  selectUserMessageMarks,
  memoizedUserMessageMarks,
} from "./conversationStore";
import type { SessionEntry, Turn, TimelineEntry } from "./types";

function userTurn(id: string, text: string, parentToolUseId: string | null = null): Turn {
  return {
    id,
    role: "user",
    status: "final",
    streamingText: text,
    streamingThinking: "",
    blocks: [],
    parentToolUseId,
    hasThinking: false,
  } as unknown as Turn;
}

function asstTurn(id: string, text = ""): Turn {
  return {
    id,
    role: "assistant",
    status: text ? "streaming" : "final",
    streamingText: text,
    streamingThinking: "",
    blocks: [],
    parentToolUseId: null,
    hasThinking: false,
  } as unknown as Turn;
}

function entry(timeline: TimelineEntry[], turns: Record<string, Turn>): SessionEntry {
  return { session: "s", timeline, turns } as unknown as SessionEntry;
}

const turnLine = (id: string): TimelineEntry => ({ kind: "turn", id }) as TimelineEntry;

describe("selectUserMessageHistory", () => {
  it("collects the user's root messages in timeline order", () => {
    const e = entry([turnLine("u1"), turnLine("a1"), turnLine("u2")], {
      u1: userTurn("u1", "first"),
      a1: asstTurn("a1", "reply"),
      u2: userTurn("u2", "second"),
    });
    expect(selectUserMessageHistory(e)).toEqual(["first", "second"]);
  });

  it("drops blank / whitespace-only messages", () => {
    const e = entry([turnLine("u1"), turnLine("u2"), turnLine("u3")], {
      u1: userTurn("u1", "keep"),
      u2: userTurn("u2", "   "),
      u3: userTurn("u3", ""),
    });
    expect(selectUserMessageHistory(e)).toEqual(["keep"]);
  });

  it("collapses CONSECUTIVE duplicates but keeps non-consecutive ones", () => {
    const e = entry([turnLine("u1"), turnLine("u2"), turnLine("u3"), turnLine("u4")], {
      u1: userTurn("u1", "ls"),
      u2: userTurn("u2", "ls"), // consecutive dup → collapsed
      u3: userTurn("u3", "build"),
      u4: userTurn("u4", "ls"), // same as u1 but not consecutive → kept
    });
    expect(selectUserMessageHistory(e)).toEqual(["ls", "build", "ls"]);
  });

  it("excludes sub-agent (Task) user turns", () => {
    const e = entry([turnLine("u1"), turnLine("sub")], {
      u1: userTurn("u1", "real"),
      sub: userTurn("sub", "tool injected", "toolu_123"),
    });
    expect(selectUserMessageHistory(e)).toEqual(["real"]);
  });

  it("excludes CLI-injected <task-notification> markers but keeps prose that only mentions the tag", () => {
    // A real injection OPENS on the tag → dropped (it's Claude talking to itself).
    const notif = "<task-notification>\n<status>completed</status>\n</task-notification>";
    // Prose that merely references the tag never opens on it → a genuine user message, kept.
    const mention = "how do I read a <task-notification> block?";
    const e = entry([turnLine("u1"), turnLine("tn"), turnLine("u2")], {
      u1: userTurn("u1", "real ask"),
      tn: userTurn("tn", notif),
      u2: userTurn("u2", mention),
    });
    expect(selectUserMessageHistory(e)).toEqual(["real ask", mention]);
  });

  it("ignores non-turn timeline entries and assistant turns", () => {
    const e = entry(
      [turnLine("u1"), { kind: "notice", id: "n1" } as TimelineEntry, turnLine("a1")],
      { u1: userTurn("u1", "hi"), a1: asstTurn("a1", "yo") },
    );
    expect(selectUserMessageHistory(e)).toEqual(["hi"]);
  });

  it("returns a shared empty array for no entry / no user messages", () => {
    expect(selectUserMessageHistory(undefined)).toEqual([]);
    const e = entry([turnLine("a1")], { a1: asstTurn("a1", "only assistant") });
    expect(selectUserMessageHistory(e)).toEqual([]);
    // Same reference for the empty case (stable → no needless re-render).
    expect(selectUserMessageHistory(undefined)).toBe(selectUserMessageHistory(e));
  });
});

describe("selectUserMessageMarks (minimap anchors)", () => {
  it("carries each message's turn id, in timeline order", () => {
    const e = entry([turnLine("u1"), turnLine("a1"), turnLine("u2")], {
      u1: userTurn("u1", "first"),
      a1: asstTurn("a1", "reply"),
      u2: userTurn("u2", "second"),
    });
    expect(selectUserMessageMarks(e)).toEqual([
      { id: "u1", text: "first" },
      { id: "u2", text: "second" },
    ]);
  });

  it("KEEPS consecutive duplicates — two identical sends are two places in the thread", () => {
    const e = entry([turnLine("u1"), turnLine("u2")], {
      u1: userTurn("u1", "ok"),
      u2: userTurn("u2", "ok"),
    });
    // The history collapses them (shell recall); the minimap must not, or the second
    // bubble would have no bar and be unreachable.
    expect(selectUserMessageHistory(e)).toEqual(["ok"]);
    expect(selectUserMessageMarks(e).map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("keeps an IMAGE-ONLY send (it is a bubble) while the history drops it", () => {
    const imgTurn = { ...userTurn("u2", ""), images: [{ data: "x", mediaType: "image/png" }] };
    const e = entry([turnLine("u1"), turnLine("u2")], {
      u1: userTurn("u1", "look at this"),
      u2: imgTurn as unknown as Turn,
    });
    expect(selectUserMessageMarks(e).map((m) => m.id)).toEqual(["u1", "u2"]);
    // Nothing to recall into the composer for an image-only turn.
    expect(selectUserMessageHistory(e)).toEqual(["look at this"]);
  });

  it("applies the same exclusions as the history (sub-agent turns, injected markers, blanks)", () => {
    const notif = "<task-notification>\n<status>completed</status>\n</task-notification>";
    const e = entry(
      [turnLine("u1"), turnLine("sub"), turnLine("tn"), turnLine("blank")],
      {
        u1: userTurn("u1", "real"),
        sub: userTurn("sub", "tool injected", "toolu_1"),
        tn: userTurn("tn", notif),
        blank: userTurn("blank", "   "),
      },
    );
    expect(selectUserMessageMarks(e).map((m) => m.id)).toEqual(["u1"]);
  });

  it("returns a shared empty array when there is nothing to map", () => {
    expect(selectUserMessageMarks(undefined)).toEqual([]);
    const e = entry([turnLine("a1")], { a1: asstTurn("a1", "only assistant") });
    expect(selectUserMessageMarks(e)).toBe(selectUserMessageMarks(undefined));
  });
});

describe("memoizedUserMessageMarks (timeline-identity memo)", () => {
  it("keeps the SAME array reference across a streamed token", () => {
    const timeline = [turnLine("u1"), turnLine("u2")];
    const turns = { u1: userTurn("u1", "a"), u2: userTurn("u2", "b") };
    const r1 = memoizedUserMessageMarks("mm-1", entry(timeline, turns));
    // New entry + new turns map, same timeline reference — the marks are OBJECTS, so a
    // re-walk here would re-render the minimap on every token.
    const r2 = memoizedUserMessageMarks(
      "mm-1",
      entry(timeline, { ...turns, a1: asstTurn("a1", "streaming…") }),
    );
    expect(r2).toBe(r1);
  });

  it("recomputes when a message is appended", () => {
    const t1 = [turnLine("u1")];
    const r1 = memoizedUserMessageMarks("mm-2", entry(t1, { u1: userTurn("u1", "a") }));
    const r2 = memoizedUserMessageMarks(
      "mm-2",
      entry([...t1, turnLine("u2")], { u1: userTurn("u1", "a"), u2: userTurn("u2", "b") }),
    );
    expect(r2).not.toBe(r1);
    expect(r2.map((m) => m.id)).toEqual(["u1", "u2"]);
  });
});

describe("memoizedUserMessageHistory (timeline-identity memo)", () => {
  it("returns the SAME array reference while the timeline reference is unchanged", () => {
    const timeline = [turnLine("u1")];
    const e1 = entry(timeline, { u1: userTurn("u1", "hello") });
    const r1 = memoizedUserMessageHistory("s-memo-1", e1);

    // Simulate a streamed assistant token: a NEW entry object, NEW turns map, but the
    // SAME timeline reference (the per-token path never replaces timeline). The history
    // must be the cached array — no O(n) re-walk per token.
    const e2 = entry(timeline, { ...e1.turns, a1: asstTurn("a1", "streaming…") });
    const r2 = memoizedUserMessageHistory("s-memo-1", e2);

    expect(r2).toBe(r1);
  });

  it("recomputes when a new timeline entry is pushed (a real new message)", () => {
    const t1 = [turnLine("u1")];
    const e1 = entry(t1, { u1: userTurn("u1", "hello") });
    const r1 = memoizedUserMessageHistory("s-memo-2", e1);

    const t2 = [...t1, turnLine("u2")];
    const e2 = entry(t2, { u1: userTurn("u1", "hello"), u2: userTurn("u2", "world") });
    const r2 = memoizedUserMessageHistory("s-memo-2", e2);

    expect(r2).not.toBe(r1);
    expect(r2).toEqual(["hello", "world"]);
  });

  it("keys the cache per session (no cross-talk)", () => {
    const ea = entry([turnLine("u1")], { u1: userTurn("u1", "A") });
    const eb = entry([turnLine("u1")], { u1: userTurn("u1", "B") });
    expect(memoizedUserMessageHistory("s-A", ea)).toEqual(["A"]);
    expect(memoizedUserMessageHistory("s-B", eb)).toEqual(["B"]);
  });

  it("returns empty for an undefined entry", () => {
    expect(memoizedUserMessageHistory("s-none", undefined)).toEqual([]);
  });
});
