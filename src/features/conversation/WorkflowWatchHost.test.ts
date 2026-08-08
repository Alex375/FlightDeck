import { describe, expect, it } from "vitest";
import { runningWorkflowKeys } from "./WorkflowWatchHost";

/** Minimal task shape the selector reads (the store holds full BackgroundTasks). */
const task = (p: Partial<{ kind: string; status: string; tool_use_id: string | null }>) => ({
  kind: "workflow",
  status: "running",
  tool_use_id: "toolu_1",
  ...p,
});

describe("runningWorkflowKeys", () => {
  it("selects only running workflows, across conversations", () => {
    expect(
      runningWorkflowKeys({
        c1: {
          t1: task({}),
          t2: task({ status: "completed" }), // finished → nothing left to watch
          t3: task({ kind: "agent" }), // a sub-agent is not a workflow run
        },
        c2: { t4: task({ tool_use_id: "toolu_2" }) },
      }),
    ).toEqual(["c1|toolu_1", "c2|toolu_2"]);
  });

  it("skips a workflow with no tool_use_id", () => {
    // Without it there is no tool_result to read the run id from, so watching would mean
    // guessing which run it is.
    expect(runningWorkflowKeys({ c1: { t1: task({ tool_use_id: null }) } })).toEqual([]);
  });

  it("is stable across re-runs so the host doesn't re-render on every progress tick", () => {
    const sessions = { c2: { t2: task({ tool_use_id: "b" }) }, c1: { t1: task({ tool_use_id: "a" }) } };
    // Sorted → the same set always yields the same array, whatever the object iteration order.
    expect(runningWorkflowKeys(sessions)).toEqual(runningWorkflowKeys({ ...sessions }));
    expect(runningWorkflowKeys(sessions)).toEqual(["c1|a", "c2|b"]);
  });

  it("returns nothing when no workflow is running", () => {
    expect(runningWorkflowKeys({})).toEqual([]);
    expect(runningWorkflowKeys({ c1: {} })).toEqual([]);
  });
});
