import { describe, expect, it } from "vitest";
import type { JsonValue, NormalizedBlock } from "../../ipc/client";
import type { SessionEntry } from "../../store/types";
import {
  clearAllTelemetryCache,
  closeBucket,
  deckStatus,
  fmtClock,
  fmtSpan,
  HISTOGRAM_BUCKETS,
  histogramArrivals,
  histogramBars,
  liveInFlight,
  memoizedTelemetry,
  selectTelemetry,
  TELEMETRY_FEED_SIZE,
  toolFamily,
} from "./telemetry";

function tuse(id: string, name: string, input: Record<string, unknown> = {}): NormalizedBlock {
  return { type: "tool_use", id, name, input } as unknown as NormalizedBlock;
}

/** A minimal SessionEntry: assistant turns (optionally a sub-agent's), tool results (ids in
 *  `errored` come back is_error) and turn results. */
function entryOf(
  turns: Array<{ id: string; parent?: string | null; blocks: NormalizedBlock[] }>,
  results: Record<string, JsonValue> = {},
  errored: string[] = [],
  turnResults: Array<{ cost?: number | null; apiMs?: number | null; ms?: number | null }> = [],
  stamps: { startedAt?: Record<string, number>; durations?: Record<string, number> } = {},
): SessionEntry {
  const turnMap: Record<string, unknown> = {};
  const timeline: Array<{ kind: "turn"; id: string }> = [];
  for (const t of turns) {
    turnMap[t.id] = {
      id: t.id,
      role: "assistant",
      status: "final",
      streamingText: "",
      streamingThinking: "",
      blocks: t.blocks,
      parentToolUseId: t.parent ?? null,
      hasThinking: false,
    };
    if (!t.parent) timeline.push({ kind: "turn", id: t.id });
  }
  const toolResults: Record<string, unknown> = {};
  for (const [id, content] of Object.entries(results)) {
    toolResults[id] = { toolUseId: id, content, isError: errored.includes(id), parentToolUseId: null };
  }
  const tr: Record<string, unknown> = {};
  turnResults.forEach((r, i) => {
    tr[`r${i}`] = {
      subtype: "success",
      isError: false,
      result: null,
      apiErrorStatus: null,
      totalCostUsd: r.cost ?? null,
      numTurns: 1,
      durationMs: r.ms ?? null,
      durationApiMs: r.apiMs ?? null,
      ttftMs: null,
    };
  });
  return {
    timeline,
    turns: turnMap,
    toolResults,
    subThreads: {},
    turnResults: tr,
    toolStartedAt: stamps.startedAt ?? {},
    toolDurations: stamps.durations ?? {},
  } as unknown as SessionEntry;
}

describe("toolFamily", () => {
  it("sorts the agent's tools onto the six dials", () => {
    expect(toolFamily("Read")).toBe("read");
    expect(toolFamily("Edit")).toBe("edit");
    expect(toolFamily("MultiEdit")).toBe("edit");
    expect(toolFamily("Write")).toBe("edit");
    expect(toolFamily("ApplyPatch")).toBe("edit"); // Codex
    expect(toolFamily("Bash")).toBe("shell");
    expect(toolFamily("Monitor")).toBe("shell");
    expect(toolFamily("Grep")).toBe("search");
    expect(toolFamily("Glob")).toBe("search");
    expect(toolFamily("Agent")).toBe("agent");
    expect(toolFamily("Task")).toBe("agent"); // older transcripts
    expect(toolFamily("WebFetch")).toBe("web");
    expect(toolFamily("WebSearch")).toBe("web");
  });

  it("keeps everything else countable without inventing a dial for it", () => {
    expect(toolFamily("Skill")).toBe("other");
    expect(toolFamily("TodoWrite")).toBe("other");
    expect(toolFamily("mcp__tosse__get_tasks")).toBe("other");
    expect(toolFamily("Artifact")).toBe("other");
  });
});

describe("selectTelemetry", () => {
  it("reads as not known on an empty conversation, never as fake zeros of cost", () => {
    const t = selectTelemetry(entryOf([]));
    expect(t.totalCalls).toBe(0);
    expect(t.costUsd).toBeNull();
    expect(t.modelMs).toBeNull();
    expect(t.events).toEqual([]);
  });

  it("counts calls per family, failures separately, and the total", () => {
    const e = entryOf(
      [
        {
          id: "t1",
          blocks: [
            tuse("a", "Read", { file_path: "/repo/src/a.ts" }),
            tuse("b", "Read", { file_path: "/repo/src/b.ts" }),
            tuse("c", "Bash", { command: "pnpm test" }),
            tuse("d", "Skill", { skill: "land" }),
          ],
        },
      ],
      { a: "ok", b: "ok", c: "1 failed", d: "ok" },
      ["c"],
    );
    const t = selectTelemetry(e);
    expect(t.counts.read).toBe(2);
    expect(t.counts.shell).toBe(1);
    expect(t.counts.other).toBe(1);
    expect(t.errors.shell).toBe(1);
    expect(t.errors.read).toBe(0);
    expect(t.totalCalls).toBe(4);
  });

  it("counts DISTINCT files touched by the edit family, a Codex patch's files included", () => {
    const e = entryOf([
      {
        id: "t1",
        blocks: [
          tuse("a", "Edit", { file_path: "/r/a.ts" }),
          tuse("b", "Edit", { file_path: "/r/a.ts" }), // same file twice
          tuse("c", "Write", { file_path: "/r/b.ts" }),
          tuse("d", "ApplyPatch", { changes: [{ path: "/r/c.ts" }, { path: "/r/a.ts" }] }),
          tuse("e", "Read", { file_path: "/r/z.ts" }), // a read touches nothing
        ],
      },
    ]);
    expect(selectTelemetry(e).filesTouched).toBe(3);
  });

  it("includes the work a SUB-AGENT did, flagged as such", () => {
    const e = entryOf(
      [
        { id: "t1", blocks: [tuse("ag", "Agent", { description: "explore" })] },
        { id: "s1", parent: "ag", blocks: [tuse("r1", "Read", { file_path: "/r/x.ts" })] },
      ],
      { ag: "done", r1: "ok" },
    );
    const t = selectTelemetry(e);
    expect(t.subAgents).toBe(1);
    expect(t.counts.read).toBe(1);
    expect(t.events.find((ev) => ev.id === "r1")?.sub).toBe(true);
    expect(t.events.find((ev) => ev.id === "ag")?.sub).toBe(false);
  });

  it("keeps a call RUNNING until its result lands", () => {
    const e = entryOf([{ id: "t1", blocks: [tuse("a", "Bash", { command: "sleep 30" })] }]);
    expect(selectTelemetry(e).events[0].status).toBe("running");
  });

  it("feeds the newest calls first, capped, with a readable one-line target", () => {
    const blocks = Array.from({ length: 10 }, (_, i) =>
      tuse(`c${i}`, i === 9 ? "Bash" : "Read", i === 9 ? { command: "pnpm build\n--mode x" } : { file_path: `/r/f${i}.ts` }),
    );
    const t = selectTelemetry(entryOf([{ id: "t1", blocks }]));
    expect(t.events).toHaveLength(TELEMETRY_FEED_SIZE);
    expect(t.events[0]).toMatchObject({ id: "c9", family: "shell", target: "pnpm build" });
    expect(t.events[1]).toMatchObject({ id: "c8", target: "f8.ts" });
  });

  it("sums cost and model time only over the turns that reported them", () => {
    const e = entryOf([], {}, [], [{ cost: 0.12, apiMs: 4000 }, { cost: null, apiMs: null }, { cost: 0.03, apiMs: 1500 }]);
    const t = selectTelemetry(e);
    expect(t.turns).toBe(3);
    expect(t.costUsd).toBeCloseTo(0.15);
    expect(t.modelMs).toBe(5500);
  });
});

describe("live timing", () => {
  it("lists only calls running WITH a live stamp as in flight, oldest first", () => {
    const e = entryOf(
      [
        {
          id: "t1",
          blocks: [
            tuse("a", "Bash", { command: "sleep 9" }),
            tuse("b", "Read", { file_path: "/r/a.ts" }),
            tuse("c", "Grep", { pattern: "x" }), // replayed from disk: no stamp
          ],
        },
      ],
      {},
      [],
      [],
      { startedAt: { a: 1000, b: 1200 } },
    );
    const t = selectTelemetry(e);
    expect(t.inFlight.map((ev) => ev.id)).toEqual(["a", "b"]);
    expect(t.inFlight[0].startedAt).toBe(1000);
  });

  it("carries each finished call's frozen duration, and its family's median", () => {
    const e = entryOf(
      [
        {
          id: "t1",
          blocks: [
            tuse("a", "Read", { file_path: "/r/a.ts" }),
            tuse("b", "Read", { file_path: "/r/b.ts" }),
            tuse("c", "Read", { file_path: "/r/c.ts" }),
            tuse("d", "Bash", { command: "ls" }),
          ],
        },
      ],
      { a: "", b: "", c: "", d: "" },
      [],
      [],
      { durations: { a: 100, b: 300, c: 200 } },
    );
    const t = selectTelemetry(e);
    expect(t.familyMedianMs.read).toBe(200);
    // Nothing of the shell family finished LIVE: no baseline, not a zero one.
    expect(t.familyMedianMs.shell).toBeNull();
    expect(t.events.find((ev) => ev.id === "b")?.durationMs).toBe(300);
    expect(t.events.find((ev) => ev.id === "d")?.durationMs).toBeNull();
  });

  it("takes the median of the completed turns' lengths", () => {
    const e = entryOf([], {}, [], [{ ms: 10_000 }, { ms: 30_000 }, { ms: null }, { ms: 20_000 }]);
    expect(selectTelemetry(e).medianTurnMs).toBe(20_000);
  });
});

describe("memoizedTelemetry", () => {
  it("returns the SAME object when nothing it reads has changed", () => {
    clearAllTelemetryCache();
    const e = entryOf([{ id: "t1", blocks: [tuse("a", "Read", { file_path: "/r/a.ts" })] }], { a: "ok" });
    const first = memoizedTelemetry("s", e);
    // A new entry object with the same content (e.g. a streamed token replaced `turns`).
    const again = memoizedTelemetry("s", { ...e, toolResults: { ...e.toolResults } });
    expect(again).toBe(first);
  });

  it("re-derives when a result lands and flips a call's status", () => {
    clearAllTelemetryCache();
    const turns = [{ id: "t1", blocks: [tuse("a", "Bash", { command: "ls" })] }];
    expect(memoizedTelemetry("s", entryOf(turns)).events[0].status).toBe("running");
    expect(memoizedTelemetry("s", entryOf(turns, { a: "x" })).events[0].status).toBe("ok");
  });
});

describe("deckStatus (the lamp)", () => {
  const idle = { busy: false, awaitingPermission: false, retrying: false, runningTool: null, streaming: false, backgroundOps: 0 };

  it("puts a question waiting on the USER above everything — the agent is stopped", () => {
    expect(deckStatus({ ...idle, busy: true, runningTool: "Bash", awaitingPermission: true }).key).toBe("permission");
  });

  it("names the tool running, then streaming, then the silence in between", () => {
    expect(deckStatus({ ...idle, busy: true, runningTool: "Bash", streaming: true }).label).toBe("Running Bash");
    expect(deckStatus({ ...idle, busy: true, streaming: true }).key).toBe("streaming");
    expect(deckStatus({ ...idle, busy: true }).key).toBe("thinking");
  });

  it("names an MCP tool by its own name, not its server's", () => {
    expect(deckStatus({ ...idle, busy: true, runningTool: "mcp__claude_ai_TOSSE__get_tasks" }).label).toBe(
      "Running get tasks",
    );
  });

  it("reads streaming text as work even before the session reports itself busy", () => {
    expect(deckStatus({ ...idle, streaming: true }).key).toBe("streaming");
  });

  it("tells background work apart from real standby", () => {
    expect(deckStatus({ ...idle, backgroundOps: 2 }).key).toBe("background");
    expect(deckStatus(idle).key).toBe("standby");
  });
});

describe("liveInFlight (a dead session's orphan call)", () => {
  const call = { id: "a", family: "shell", tool: "Bash", target: "sleep 99", status: "running", sub: false, startedAt: 1, durationMs: null } as const;

  it("keeps a call in flight while the session does anything at all", () => {
    expect(liveInFlight([call], { busy: true, backgroundOps: 0, streaming: false })).toHaveLength(1);
    expect(liveInFlight([call], { busy: false, backgroundOps: 1, streaming: false })).toHaveLength(1);
    expect(liveInFlight([call], { busy: false, backgroundOps: 0, streaming: true })).toHaveLength(1);
  });

  it("drops it once nothing runs: its result will never come, its timer must not count forever", () => {
    expect(liveInFlight([call], { busy: false, backgroundOps: 0, streaming: false })).toEqual([]);
  });
});

describe("clock formats", () => {
  it("reads a run as m:ss, then h:mm:ss", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(65_400)).toBe("1:05");
    expect(fmtClock(3_725_000)).toBe("1:02:05");
  });

  it("reads model time as a span", () => {
    expect(fmtSpan(42_000)).toBe("42s");
    expect(fmtSpan(192_000)).toBe("3m 12s");
    expect(fmtSpan(3_840_000)).toBe("1h 04m");
  });
});

describe("the activity histogram", () => {
  it("counts only calls that ARRIVE while the deck is open — never the history it opened on", () => {
    // A transcript replayed from disk lands all at once: counting it would draw one giant
    // spike at the moment the conversation was loaded, which is not activity.
    expect(histogramArrivals(null, 240)).toBe(0);
    expect(histogramArrivals(240, 243)).toBe(3);
    expect(histogramArrivals(243, 243)).toBe(0);
    // A rewind cuts the transcript: the total shrinks, and that is no arrival either.
    expect(histogramArrivals(243, 180)).toBe(0);
  });

  it("keys every bar by the SECOND it counts, so a tick moves bars instead of re-animating them", () => {
    // Second 10 is live with 2 calls; a tick closes it and second 11 opens.
    const before = histogramBars([3, 0, 1], 2, 10);
    const after = histogramBars(closeBucket([3, 0, 1], 2), 0, 11);
    const keyOf = (bars: typeof before, value: number, live: boolean) =>
      bars.find((b) => b.value === value && b.live === live)?.key;
    // The bucket that just closed keeps its key — same DOM bar, same height, nothing to animate.
    expect(keyOf(before, 2, true)).toBe("b10");
    expect(after.find((b) => b.key === "b10")).toMatchObject({ value: 2, live: false });
    // So does every older bucket; only the new live bar is new.
    expect(after.find((b) => b.key === "b7")?.value).toBe(3);
    expect(after[after.length - 1]).toMatchObject({ key: "b11", value: 0, live: true });
  });

  it("always draws the full window", () => {
    expect(histogramBars([], 0, 0)).toHaveLength(HISTOGRAM_BUCKETS);
    expect(histogramBars(Array(HISTOGRAM_BUCKETS - 1).fill(1), 1, 500)).toHaveLength(HISTOGRAM_BUCKETS);
  });

  it("slides a fixed window, whatever its size", () => {
    const pushes = HISTOGRAM_BUCKETS + 20;
    let done: number[] = [];
    for (let i = 0; i < pushes; i++) done = closeBucket(done, i);
    expect(done).toHaveLength(HISTOGRAM_BUCKETS - 1);
    expect(done[done.length - 1]).toBe(pushes - 1);
    expect(done[0]).toBe(pushes - (HISTOGRAM_BUCKETS - 1));
  });
});
