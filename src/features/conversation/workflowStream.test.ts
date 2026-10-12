// The stream snapshot → the shapes every workflow surface reads. Driven by a REAL 2.1.293 capture
// (the same fixture the Rust assembler is tested on), so the front and the core agree on the wire.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue, WorkflowProgress } from "../../ipc/client";
import { journalTally, peekStatus, preferredView, toJournalView } from "../../store/workflowJournal";
import { liveTree, phaseRowView } from "./workflowTree";
import {
  streamActivity,
  streamAgentDetails,
  streamJournalView,
  streamPhases,
  streamRedacted,
  streamReport,
  streamStartedAt,
  streamUsable,
} from "./workflowStream";
import { normalizeState, parseWorkflow, runProgress } from "./workflowModel";

// Read from disk with `path` (see TosseView.unlink.test.ts for why not `new URL`).
const FIXTURE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../src-tauri/src/supervisor/fixtures/capture_workflow_progress_live.jsonl",
  ),
  "utf8",
);

type Line = { type: string; subtype?: string; [k: string]: JsonValue | undefined };
const lines: Line[] = FIXTURE.split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

/** Each snapshot the core would emit from the capture's `task_progress` ticks (the core drops the
 *  `workflow_log` lines; this run has none). */
const ticks: WorkflowProgress[] = lines
  .filter((l) => l.subtype === "task_progress" && Array.isArray(l.workflow_progress))
  .map((l) => ({
    task_id: l.task_id as string,
    tool_use_id: l.tool_use_id as string,
    // What the core parses from `task_started.prompt` (the script's `meta.phases`).
    declared_phases: [
      { title: "Ping", detail: null },
      { title: "Pong", detail: null },
    ],
    entries: l.workflow_progress as JsonValue,
    elapsed_ms: (l.usage as { duration_ms?: number } | undefined)?.duration_ms ?? null,
    tokens: null,
    tool_uses: null,
    settled: false,
  }));

const first = ticks[0];
const last: WorkflowProgress = { ...ticks[ticks.length - 1], settled: true, tokens: 96592, tool_uses: 0 };

const agent = (o: Record<string, JsonValue>) => ({ type: "workflow_agent", ...o });

describe("streamJournalView — the live view every surface reads", () => {
  it("the first tick: one agent running, one QUEUED (no id yet) — never both running", () => {
    expect(ticks).toHaveLength(6);
    const v = streamJournalView(first);
    expect(v.fromStream).toBe(true);
    expect(v.namesAgents).toBe(true);
    expect([v.started, v.running, v.queued, v.done]).toEqual([2, 1, 1, 0]);
    expect(v.agents.map((a) => [a.key, a.label, a.phase, a.agentId])).toEqual([
      ["wf:1", "ping:a", "Ping", "a31ec18ff8c7cef81"],
      ["wf:2", "ping:b", "Ping", null],
    ]);
  });

  it("the end of the run: every agent delivered", () => {
    const v = streamJournalView(last);
    expect([v.started, v.delivered, v.running, v.queued, v.failed]).toEqual([3, 3, 0, 0, 0]);
  });

  it("an empty agent id is no id: the agent is queued, not running", () => {
    const v = streamJournalView({
      ...first,
      entries: [agent({ index: 1, label: "x", phaseTitle: "P", state: "start", agentId: "" })],
    });
    expect(v.agents[0].agentId).toBeNull();
    expect([v.running, v.queued]).toEqual([0, 1]);
  });

  it("failed and skipped settle; a failure is counted apart", () => {
    const v = streamJournalView({
      ...first,
      entries: [
        agent({ index: 1, label: "a", phaseTitle: "P", state: "error", agentId: "x" }),
        agent({ index: 2, label: "b", phaseTitle: "P", state: "skipped" }),
        agent({ index: 3, label: "c", phaseTitle: "P", state: "progress", agentId: "y" }),
      ],
    });
    expect([v.started, v.done, v.failed, v.delivered, v.running, v.queued]).toEqual([3, 2, 1, 1, 1, 0]);
  });
});

describe("the reported bug — a remote run read from the stream", () => {
  it("lists every declared phase from the first tick, upcoming ones included", () => {
    expect(streamPhases(first).map((p) => p.title)).toEqual(["Ping", "Pong"]);
    // Without the script, the entries' own phase announcements stand in.
    expect(streamPhases({ ...first, declared_phases: [] }).map((p) => p.title)).toEqual(["Ping", "Pong"]);
  });

  it("agents spawned outside any phase add no phantom phase row", () => {
    const p: WorkflowProgress = {
      ...first,
      declared_phases: [],
      entries: [
        agent({ index: 1, label: "a", state: "start", agentId: "x" }),
        agent({ index: 2, label: "b", state: "done", agentId: "y" }),
      ],
    };
    expect(streamPhases(p)).toEqual([]);
    const tree = liveTree(streamPhases(p), streamJournalView(p), { phases: [], startedAt: null }, null, true);
    expect(tree.rows.map((r) => r.title)).toEqual(["(no phase)"]);
  });

  it("the live tree is EXACT: running agents are clickable rows, queued ones say so", () => {
    const tree = liveTree(streamPhases(first), streamJournalView(first), { phases: [], startedAt: null }, null, true);
    expect(tree.exact).toBe(true);
    const ping = tree.byPhase.get("ping") ?? [];
    expect(ping.map((a) => [a.label, a.agentId != null])).toEqual([
      ["ping:a", true],
      ["ping:b", false],
    ]);
    const rows = Object.fromEntries(tree.rows.map((r) => [r.title, r]));
    expect([rows.Ping.state, rows.Pong.state]).toEqual(["cur", "todo"]);
    expect(phaseRowView(rows.Pong).count).toBe("upcoming");
  });

  it("a phase whose agents all delivered reads N/N — not the 0/N of the by-index guess", () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      agent({ index: i + 1, label: `review:${i}`, phaseTitle: "Review", state: "done", agentId: `a${i}` }),
    );
    const p: WorkflowProgress = {
      ...first,
      declared_phases: [
        { title: "Review", detail: "defensive reviewers" },
        { title: "Consolidate", detail: null },
      ],
      entries: [...nine, agent({ index: 10, label: "merge", phaseTitle: "Consolidate", state: "start", agentId: "m" })],
    };
    const tree = liveTree(streamPhases(p), streamJournalView(p), { phases: [], startedAt: null }, null, true);
    const review = tree.rows.find((r) => r.title === "Review")!;
    expect(phaseRowView(review).count).toBe("9/9");
    expect(tree.curKey).toBe("consolidate");
    expect(review.detail).toBe("defensive reviewers");
  });

  it("the tallies count queued agents apart from running ones", () => {
    const v = streamJournalView(first);
    expect(journalTally(v, true)).toBe("1 running · 1 queued · 0/2 done");
    expect(peekStatus(v).text).toBe("1 agent running · 1 queued");
    // Over without ever leaving the queue: no result, and not "running".
    expect(journalTally(v, false)).toBe("0/2 done · 2 no result");
  });

  it("a settled run becomes a report the rich face renders as is", () => {
    const report = streamReport(last, "completed");
    expect(report.taskId).toBe("wlvqh53li");
    expect(report.totalTokens).toBe(96592);
    const model = parseWorkflow(report);
    expect(model.phases.map((ph) => [ph.title, ph.agents.length])).toEqual([
      ["Ping", 2],
      ["Pong", 1],
    ]);
    expect(runProgress(model)).toEqual({ done: 3, failed: 0, total: 3 });
    expect(model.agents.every((a) => a.model === "claude-haiku-5-5")).toBe(true);
  });
});

describe("source choice", () => {
  it("the stream wins over a journal; a REDACTED stream yields to a readable journal", () => {
    const stream = streamJournalView(first);
    const journal = toJournalView({
      started: 1,
      done: 0,
      failed: 0,
      namesAgents: true,
      agents: [{ key: "v2:k", agentId: "z", label: "real", phase: "Real", done: false, failed: false, lastStarted: 1 }],
    });
    expect(preferredView(stream, false, journal)).toBe(stream);
    expect(preferredView(stream, true, journal)).toBe(journal);
    // …but a redacted stream still beats having nothing (a remote run never has a journal here).
    expect(preferredView(stream, true, toJournalView(null))).toBe(stream);
    expect(preferredView(null, false, journal)).toBe(journal);
  });

  it("detects a redacted snapshot", () => {
    expect(streamRedacted(first)).toBe(false);
    expect(
      streamRedacted({
        ...first,
        declared_phases: [],
        entries: [
          { type: "workflow_phase", index: 1, title: "phase 1" },
          agent({ index: 1, label: "a", phaseIndex: 1, state: "start", agentId: "x" }),
        ],
      }),
    ).toBe(true);
  });

  it("an empty snapshot is not usable — nothing to show", () => {
    expect(streamUsable({ ...first, declared_phases: [], entries: [] })).toBe(false);
    expect(streamUsable({ ...first, entries: [] })).toBe(true); // phases alone are worth showing
    expect(streamUsable(null)).toBe(false);
  });
});

describe("per-agent detail and timing", () => {
  it("each agent's model, previews and last tool, by row key", () => {
    const d = streamAgentDetails(last);
    expect(d.get("wf:1")?.model).toBe("claude-haiku-5-5");
    expect(d.get("wf:3")?.resultPreview).toBe("DONE");
    expect(streamActivity({ lastToolName: "Read", lastToolSummary: "/src/a.ts" })).toBe("Read /src/a.ts");
    expect(streamActivity({ lastToolName: null, lastToolSummary: null })).toBeNull();
  });

  it("the run starts when its first agent queued — on the CLI's clock", () => {
    expect(streamStartedAt(first)).toBe(1791503857412);
    expect(streamStartedAt({ ...first, entries: [] })).toBeNull();
  });

  it("maps the live lifecycle words", () => {
    expect(normalizeState("start", null)).toBe("queued");
    expect(normalizeState("start", "a1")).toBe("running");
    expect(normalizeState("progress", "a1")).toBe("running");
    expect(normalizeState("done", "a1")).toBe("done");
    expect(normalizeState(null, null)).toBe("running");
  });
});
