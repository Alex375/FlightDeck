import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "../../ipc/client";
import {
  acceptReport,
  isTerminalState,
  parseWorkflow,
  phaseProgress,
  runProgress,
  wfStateDot,
} from "./workflowModel";

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "wf_x",
    taskId: "tk",
    status: "running",
    workflowName: "demo",
    defaultModel: "claude-opus-4-8",
    durationMs: null,
    agentCount: null,
    totalTokens: null,
    totalToolCalls: null,
    summary: null,
    phases: [],
    workflowProgress: [],
    result: null,
    ...over,
  };
}

describe("acceptReport", () => {
  it("shows a report only once the run is over, and only this execution's", () => {
    const mine = run({ taskId: "Q2", status: "completed" });
    expect(acceptReport(mine, false, "Q2")).toBe(mine);
    // While the run goes it has no report: anything on disk is a previous execution's.
    expect(acceptReport(mine, true, "Q2")).toBeNull();
    // A resumed run reuses the run id: the report on disk may be the OTHER execution's.
    expect(acceptReport(run({ taskId: "Q1" }), false, "Q2")).toBeNull();
    expect(acceptReport(null, false, "Q2")).toBeNull();
  });

  it("accepts what cannot be told apart (an unknown id on either side)", () => {
    expect(acceptReport(run({ taskId: null }), false, "Q2")).not.toBeNull();
    expect(acceptReport(run({ taskId: "Q1" }), false, null)).not.toBeNull();
  });
});

describe("parseWorkflow", () => {
  it("returns empty for a null run", () => {
    expect(parseWorkflow(null)).toEqual({ phases: [], agents: [] });
  });

  it("seeds declared phases in order, even when they have no agents", () => {
    const m = parseWorkflow(run({ phases: [{ title: "Research", detail: null }, { title: "Verify", detail: null }] }));
    expect(m.phases.map((p) => p.title)).toEqual(["Research", "Verify"]);
    expect(m.phases.every((p) => p.agents.length === 0)).toBe(true);
  });

  it("buckets agents under their phase by title and keeps run order", () => {
    const m = parseWorkflow(
      run({
        phases: [{ title: "Research", detail: null }],
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Research" },
          { type: "workflow_agent", index: 1, label: "r-alpha", phaseTitle: "Research", phaseIndex: 1, agentId: "aa", model: "claude-opus-4-8", state: "done", tokens: 11174, toolCalls: 2, durationMs: 859, resultPreview: "ALPHA" },
          { type: "workflow_agent", index: 2, label: "r-beta", phaseTitle: "Research", phaseIndex: 1, agentId: "bb", state: "running" },
        ],
      }),
    );
    expect(m.phases).toHaveLength(1);
    expect(m.phases[0].agents.map((a) => a.label)).toEqual(["r-alpha", "r-beta"]);
    expect(m.agents).toHaveLength(2);
    const a = m.phases[0].agents[0];
    expect(a.agentId).toBe("aa");
    expect(a.tokens).toBe(11174);
    expect(a.durationMs).toBe(859);
    expect(a.resultPreview).toBe("ALPHA");
  });

  it("creates a phase for a progress-only phase not in declared phases[]", () => {
    const m = parseWorkflow(
      run({
        phases: [],
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Verify" },
          { type: "workflow_agent", label: "v1", phaseTitle: "Verify", state: "queued", agentId: "v" },
        ],
      }),
    );
    expect(m.phases.map((p) => p.title)).toEqual(["Verify"]);
    expect(m.phases[0].agents[0].label).toBe("v1");
  });

  it("preserves two declared phases with the SAME title (no phase lost)", () => {
    const m = parseWorkflow(
      run({
        phases: [
          { title: "Review", detail: "first pass" },
          { title: "Review", detail: "second pass" },
        ],
        workflowProgress: [
          { type: "workflow_agent", label: "a", phaseTitle: "Review", state: "done", agentId: "a" },
        ],
      }),
    );
    // Both declared "Review" phases survive (the 2nd is NOT merged away).
    expect(m.phases.map((p) => p.title)).toEqual(["Review", "Review"]);
    expect(m.phases[0].detail).toBe("first pass");
    expect(m.phases[1].detail).toBe("second pass");
    // The agent attaches to the first matching phase.
    expect(m.phases[0].agents.map((a) => a.label)).toEqual(["a"]);
    expect(m.phases[1].agents).toEqual([]);
  });

  it("never drops an orphan agent with no phase info", () => {
    const m = parseWorkflow(
      run({ workflowProgress: [{ type: "workflow_agent", label: "lonely", state: "done", agentId: "l" }] }),
    );
    expect(m.agents).toHaveLength(1);
    expect(m.phases).toHaveLength(1);
    expect(m.phases[0].agents[0].label).toBe("lonely");
  });

  it("tolerates a non-array workflowProgress (raw manifest defaulted to null/object)", () => {
    expect(parseWorkflow(run({ workflowProgress: null as never })).agents).toEqual([]);
    expect(parseWorkflow(run({ workflowProgress: {} as never })).agents).toEqual([]);
  });

  it("falls back the agent label to agentId then 'agent'", () => {
    const m = parseWorkflow(
      run({
        workflowProgress: [
          { type: "workflow_agent", agentId: "abc", state: "done" },
          { type: "workflow_agent", state: "done" },
        ],
      }),
    );
    expect(m.agents.map((a) => a.label)).toEqual(["abc", "agent"]);
  });
});

describe("phaseProgress / runProgress", () => {
  const m = parseWorkflow(
    run({
      workflowProgress: [
        { type: "workflow_agent", label: "a", phaseTitle: "P", state: "done", agentId: "a" },
        { type: "workflow_agent", label: "b", phaseTitle: "P", state: "running", agentId: "b" },
        { type: "workflow_agent", label: "c", phaseTitle: "P", state: "error", agentId: "c" },
      ],
    }),
  );

  it("counts settled (done/error) agents as the X in X/N", () => {
    // `done` = settled (the error counts), `failed` counted apart — the same three numbers the
    // live journal gives, so the report words the run exactly like the live view.
    expect(phaseProgress(m.phases[0])).toEqual({ done: 2, failed: 1, total: 3 });
    expect(runProgress(m)).toEqual({ done: 2, failed: 1, total: 3 });
  });
});

describe("isTerminalState / wfStateDot", () => {
  it("treats done/completed/error/failed/skipped as terminal", () => {
    for (const s of ["done", "completed", "error", "failed", "skipped", "DONE"]) {
      expect(isTerminalState(s)).toBe(true);
    }
    for (const s of ["running", "queued", "pending", "whatever"]) {
      expect(isTerminalState(s)).toBe(false);
    }
  });

  it("maps states to dot tokens (unknown → running look)", () => {
    expect(wfStateDot("done")).toBe("done");
    expect(wfStateDot("completed")).toBe("done");
    expect(wfStateDot("error")).toBe("err");
    expect(wfStateDot("failed")).toBe("err");
    expect(wfStateDot("queued")).toBe("off");
    expect(wfStateDot("running")).toBe("work");
    expect(wfStateDot("mystery")).toBe("work");
  });
});
