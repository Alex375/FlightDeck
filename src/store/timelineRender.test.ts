import { describe, it, expect } from "vitest";
import { planTimelineRender, coalesceCleanRounds, type RenderItem } from "./conversationStore";
import type { SessionEntry, TimelineEntry, Turn } from "./types";

function turn(id: string, role: "user" | "assistant"): Turn {
  return {
    id,
    role,
    status: "streaming",
    streamingText: "",
    streamingThinking: "",
    blocks: [],
    parentToolUseId: null,
    hasThinking: false,
  } as Turn;
}

function entry(timeline: TimelineEntry[], turns: Record<string, Turn>): SessionEntry {
  return { timeline, turns } as unknown as SessionEntry;
}

describe("planTimelineRender", () => {
  it("coalesces consecutive assistant turns into one ai group", () => {
    const plan = planTimelineRender(
      entry(
        [
          { kind: "turn", id: "u1" },
          { kind: "turn", id: "a1" },
          { kind: "turn", id: "a2" },
          { kind: "turn", id: "a3" },
        ],
        {
          u1: turn("u1", "user"),
          a1: turn("a1", "assistant"),
          a2: turn("a2", "assistant"),
          a3: turn("a3", "assistant"),
        },
      ),
    );
    expect(plan.map((p) => p.kind)).toEqual(["user", "ai"]);
    expect(plan[1]).toEqual({ kind: "ai", ids: ["a1", "a2", "a3"] });
  });

  it("a user message breaks the group (the only thing that splits a tool run)", () => {
    const plan = planTimelineRender(
      entry(
        [
          { kind: "turn", id: "a1" },
          { kind: "turn", id: "u1" },
          { kind: "turn", id: "a2" },
        ],
        { a1: turn("a1", "assistant"), u1: turn("u1", "user"), a2: turn("a2", "assistant") },
      ),
    );
    expect(plan).toEqual([
      { kind: "ai", ids: ["a1"] },
      { kind: "user", id: "u1" },
      { kind: "ai", ids: ["a2"] },
    ]);
  });

  it("non-turn entries (turn_result / error) break the group and pass through", () => {
    const plan = planTimelineRender(
      entry(
        [
          { kind: "turn", id: "a1" },
          { kind: "turn_result", id: "tr" },
          { kind: "turn", id: "a2" },
          { kind: "error", id: "er" },
        ],
        { a1: turn("a1", "assistant"), a2: turn("a2", "assistant") },
      ),
    );
    expect(plan.map((p) => p.kind)).toEqual(["ai", "turn_result", "ai", "error"]);
  });

  it("returns empty for no entry / empty timeline", () => {
    expect(planTimelineRender(undefined)).toEqual([]);
    expect(planTimelineRender(entry([], {}))).toEqual([]);
  });
});

// Clean-output coalescing: a mid-turn marker split the response into two `ai` groups; this
// merges them back into one round with the marker(s) absorbed inline. Control changes are
// soft; a user turn is absorbed ONLY when it was injected mid-work (durable injectedMidTurn) —
// a genuine new prompt, and everything else (turn_result / error / non-control notice), is a
// hard boundary that ends the round.
describe("coalesceCleanRounds", () => {
  const ai = (...ids: string[]): RenderItem => ({ kind: "ai", ids });
  const user = (id: string): RenderItem => ({ kind: "user", id });
  const nt = (id: string): RenderItem => ({ kind: "notice", id });
  const tr = (id: string): RenderItem => ({ kind: "turn_result", id });
  const err = (id: string): RenderItem => ({ kind: "error", id });
  // Only `cc` is a control_change; any other notice id resolves to an error subtype.
  const subtype = (id: string) => (id === "cc" ? "control_change" : "process_exited");
  // A user id starting with "uinj" was injected mid-work (queued while busy); everything else
  // (p1, p2, u1…) is a genuine new prompt.
  const injected = (id: string) => id.startsWith("uinj");

  it("absorbs a control-change bar mid-response into one round (marker in place)", () => {
    const out = coalesceCleanRounds([ai("a1"), nt("cc"), ai("a2")], subtype, injected);
    expect(out).toEqual([
      { kind: "ai", ids: ["a1", "a2"], markers: [{ markerKind: "notice", id: "cc", after: 1 }] },
    ]);
  });

  it("absorbs a message INJECTED mid-work into one round (same treatment as the bar)", () => {
    const out = coalesceCleanRounds([ai("a1"), user("uinj"), ai("a2")], subtype, injected);
    expect(out).toEqual([
      { kind: "ai", ids: ["a1", "a2"], markers: [{ markerKind: "user", id: "uinj", after: 1 }] },
    ]);
  });

  it("does NOT absorb a genuine new prompt (not injected) — it splits the round", () => {
    // Same shape as the injected case above, but p2 is a real prompt → two separate rounds.
    const out = coalesceCleanRounds([ai("a1"), user("p2"), ai("a2")], subtype, injected);
    expect(out).toEqual([
      { kind: "ai", ids: ["a1"] },
      { kind: "user", id: "p2" },
      { kind: "ai", ids: ["a2"] },
    ]);
  });

  it("RESUMED conversation (no turn_result, no injected prompts) stays as SEPARATE rounds", () => {
    // Hydrated history carries no turn_result and no injection flag. Every prompt is a real one,
    // so nothing must be absorbed — otherwise the whole conversation collapses into one fold.
    const plan = [
      user("p1"), ai("a1"),
      user("p2"), ai("a2"),
      user("p3"), ai("a3"),
    ];
    const out = coalesceCleanRounds(plan, subtype, injected);
    expect(out).toEqual(plan); // untouched: three separate exchanges
  });

  it("keeps a LEADING user message (the real prompt) as its own item — not absorbed", () => {
    const out = coalesceCleanRounds([user("uinj1"), ai("a1")], subtype, injected);
    // Even an injected-flagged id leading the plan is not absorbed (no round to join yet).
    expect(out).toEqual([{ kind: "user", id: "uinj1" }, { kind: "ai", ids: ["a1"] }]);
  });

  it("a turn_result ends the round: a user message after it starts fresh", () => {
    const out = coalesceCleanRounds([ai("a1"), tr("r1"), user("p2"), ai("a2")], subtype, injected);
    expect(out).toEqual([
      { kind: "ai", ids: ["a1"] },
      { kind: "turn_result", id: "r1" },
      { kind: "user", id: "p2" },
      { kind: "ai", ids: ["a2"] },
    ]);
  });

  it("a non-control notice (an error) is a HARD boundary — it splits the round", () => {
    const out = coalesceCleanRounds([ai("a1"), nt("boom"), ai("a2")], subtype, injected);
    expect(out).toEqual([
      { kind: "ai", ids: ["a1"] },
      { kind: "notice", id: "boom" },
      { kind: "ai", ids: ["a2"] },
    ]);
  });

  it("a failed background task (task_failed) is SOFT — absorbed like a failed tool step", () => {
    const sub = (id: string) => (id === "tf" ? "task_failed" : "process_exited");
    const out = coalesceCleanRounds([ai("a1"), nt("tf"), ai("a2")], sub, injected);
    expect(out).toEqual([
      { kind: "ai", ids: ["a1", "a2"], markers: [{ markerKind: "notice", id: "tf", after: 1 }] },
    ]);
  });

  it("an error item is a hard boundary too", () => {
    const out = coalesceCleanRounds([ai("a1"), err("e1"), ai("a2")], subtype, injected);
    expect(out).toEqual([
      { kind: "ai", ids: ["a1"] },
      { kind: "error", id: "e1" },
      { kind: "ai", ids: ["a2"] },
    ]);
  });

  it("absorbs SEVERAL markers in one round, each at its own turn boundary", () => {
    const out = coalesceCleanRounds(
      [ai("a1"), nt("cc"), ai("a2"), user("uinj"), ai("a3")],
      subtype,
      injected,
    );
    expect(out).toEqual([
      {
        kind: "ai",
        ids: ["a1", "a2", "a3"],
        markers: [
          { markerKind: "notice", id: "cc", after: 1 },
          { markerKind: "user", id: "uinj", after: 2 },
        ],
      },
    ]);
  });

  it("leaves a marker-free plan untouched (no markers key added)", () => {
    const out = coalesceCleanRounds([user("u1"), ai("a1", "a2"), tr("r1")], subtype, injected);
    expect(out).toEqual([
      { kind: "user", id: "u1" },
      { kind: "ai", ids: ["a1", "a2"] },
      { kind: "turn_result", id: "r1" },
    ]);
  });
});
