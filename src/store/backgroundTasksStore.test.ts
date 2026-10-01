import { describe, it, expect, beforeEach } from "vitest";
import type { BackgroundTask } from "../ipc/client";
import {
  orderBashTasks,
  orderMonitorTasks,
  orderWorkflowTasks,
  runningCountsByConv,
  runningBashCountsByConv,
  launchTask,
  useBackgroundTasksStore,
} from "./backgroundTasksStore";

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    task_id: "tk1",
    kind: "agent",
    tool_use_id: "toolu_1",
    label: "do the thing",
    command: null,
    subagent_type: "Explore",
    model: "claude-haiku-4-5",
    agent_id: "aa11",
    status: "running",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: null,
    woken_by: null,
    ...over,
  };
}

describe("backgroundTasksStore", () => {
  beforeEach(() => useBackgroundTasksStore.getState().clear());

  it("applyTask registers a task under its conversation, keyed by task_id", () => {
    useBackgroundTasksStore.getState().applyTask("conv-a", task());
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"].status).toBe("running");
  });

  it("applyTask replaces by task_id (snapshots are cumulative, not patches)", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task());
    applyTask("conv-a", task({ status: "completed", tokens: 1200, duration_ms: 4321 }));
    const t = useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"];
    expect(t.status).toBe("completed");
    expect(t.tokens).toBe(1200);
    expect(t.duration_ms).toBe(4321);
  });

  it("is idempotent on an identical re-delivery (no state churn)", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task());
    const before = useBackgroundTasksStore.getState().sessions;
    applyTask("conv-a", task()); // same snapshot (Tauri delivers at-least-once)
    expect(useBackgroundTasksStore.getState().sessions).toBe(before); // same reference
  });

  // Task 9ab0edf7 (review): a snapshot differing ONLY by the wake flag (a running task the
  // wire then confirms as woken by the main thread) must reach the AgentBar.
  it("a woken_by change is NOT deduped", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ woken_by: null }));
    applyTask("conv-a", task({ woken_by: "tu-send" }));
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"].woken_by).toBe("tu-send");
  });

  it("a model change is NOT deduped (the sub-agent's model must reach the UI)", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ model: null }));
    const before = useBackgroundTasksStore.getState().sessions;
    applyTask("conv-a", task({ model: "claude-haiku-4-5" }));
    expect(useBackgroundTasksStore.getState().sessions).not.toBe(before); // re-rendered
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"].model).toBe(
      "claude-haiku-4-5",
    );
  });

  it("keeps tasks of different conversations isolated", () => {
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ task_id: "tk1" }));
    applyTask("conv-b", task({ task_id: "tk2" }));
    expect(Object.keys(useBackgroundTasksStore.getState().sessions["conv-a"])).toEqual(["tk1"]);
    expect(Object.keys(useBackgroundTasksStore.getState().sessions["conv-b"])).toEqual(["tk2"]);
  });

  it("dropSession forgets one conversation's tasks only", () => {
    const { applyTask, dropSession } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task());
    applyTask("conv-b", task({ task_id: "tk2" }));
    dropSession("conv-a");
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]).toBeUndefined();
    expect(useBackgroundTasksStore.getState().sessions["conv-b"]).toBeDefined();
  });

  it("endSession flips still-running tasks to stopped (leaves finished ones)", () => {
    const { applyTask, endSession } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ task_id: "r", status: "running" }));
    applyTask("conv-a", task({ task_id: "d", status: "completed" }));
    endSession("conv-a");
    const tasks = useBackgroundTasksStore.getState().sessions["conv-a"];
    expect(tasks["r"].status).toBe("stopped");
    expect(tasks["d"].status).toBe("completed"); // untouched
  });

  it("clear wipes everything", () => {
    useBackgroundTasksStore.getState().applyTask("conv-a", task());
    useBackgroundTasksStore.getState().clear();
    expect(useBackgroundTasksStore.getState().sessions).toEqual({});
  });
});

describe("orderBashTasks", () => {
  const map = (...ts: BackgroundTask[]): Record<string, BackgroundTask> =>
    Object.fromEntries(ts.map((t) => [t.task_id, t]));

  it("keeps only RUNNING bash (drops agent/monitor/workflow AND finished bash)", () => {
    const got = orderBashTasks(
      map(
        task({ task_id: "a", kind: "agent", status: "running" }),
        task({ task_id: "b", kind: "bash", status: "running" }),
        task({ task_id: "m", kind: "monitor", status: "running" }),
        task({ task_id: "w", kind: "workflow", status: "running" }),
        task({ task_id: "done", kind: "bash", status: "completed" }),
        task({ task_id: "stopped", kind: "bash", status: "stopped" }),
        task({ task_id: "failed", kind: "bash", status: "failed" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["b"]);
  });

  it("orders running bash by task_id", () => {
    const got = orderBashTasks(
      map(
        task({ task_id: "tk_3", kind: "bash", status: "running" }),
        task({ task_id: "tk_1", kind: "bash", status: "running" }),
        task({ task_id: "tk_2", kind: "bash", status: "running" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["tk_1", "tk_2", "tk_3"]);
  });

  it("is empty when there is no RUNNING bash (none, or only finished)", () => {
    expect(orderBashTasks({})).toEqual([]);
    expect(
      orderBashTasks(
        map(
          task({ task_id: "a", kind: "agent", status: "running" }),
          task({ task_id: "d", kind: "bash", status: "completed" }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("orderMonitorTasks", () => {
  const map = (...ts: BackgroundTask[]): Record<string, BackgroundTask> =>
    Object.fromEntries(ts.map((t) => [t.task_id, t]));

  it("keeps only RUNNING monitor (drops agent/bash/workflow AND finished monitor)", () => {
    const got = orderMonitorTasks(
      map(
        task({ task_id: "a", kind: "agent", status: "running" }),
        task({ task_id: "b", kind: "bash", status: "running" }),
        task({ task_id: "m", kind: "monitor", status: "running" }),
        task({ task_id: "w", kind: "workflow", status: "running" }),
        task({ task_id: "done", kind: "monitor", status: "completed" }),
        task({ task_id: "stopped", kind: "monitor", status: "stopped" }),
        task({ task_id: "failed", kind: "monitor", status: "failed" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["m"]);
  });

  it("orders running monitors by task_id", () => {
    const got = orderMonitorTasks(
      map(
        task({ task_id: "tk_3", kind: "monitor", status: "running" }),
        task({ task_id: "tk_1", kind: "monitor", status: "running" }),
        task({ task_id: "tk_2", kind: "monitor", status: "running" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["tk_1", "tk_2", "tk_3"]);
  });

  it("is empty when there is no RUNNING monitor (none, or only finished)", () => {
    expect(orderMonitorTasks({})).toEqual([]);
    expect(
      orderMonitorTasks(
        map(
          task({ task_id: "b", kind: "bash", status: "running" }),
          task({ task_id: "d", kind: "monitor", status: "completed" }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("orderWorkflowTasks", () => {
  const map = (...ts: BackgroundTask[]): Record<string, BackgroundTask> =>
    Object.fromEntries(ts.map((t) => [t.task_id, t]));

  it("keeps only RUNNING workflow (drops other kinds AND finished workflow)", () => {
    const got = orderWorkflowTasks(
      map(
        task({ task_id: "a", kind: "agent", status: "running" }),
        task({ task_id: "b", kind: "bash", status: "running" }),
        task({ task_id: "m", kind: "monitor", status: "running" }),
        task({ task_id: "w", kind: "workflow", status: "running" }),
        task({ task_id: "done", kind: "workflow", status: "completed" }),
        task({ task_id: "stopped", kind: "workflow", status: "stopped" }),
        task({ task_id: "failed", kind: "workflow", status: "failed" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["w"]);
  });

  it("orders running workflows by task_id", () => {
    const got = orderWorkflowTasks(
      map(
        task({ task_id: "tk_3", kind: "workflow", status: "running" }),
        task({ task_id: "tk_1", kind: "workflow", status: "running" }),
        task({ task_id: "tk_2", kind: "workflow", status: "running" }),
      ),
    );
    expect(got.map((t) => t.task_id)).toEqual(["tk_1", "tk_2", "tk_3"]);
  });

  it("is empty when there is no RUNNING workflow (none, or only finished)", () => {
    expect(orderWorkflowTasks({})).toEqual([]);
    expect(
      orderWorkflowTasks(
        map(
          task({ task_id: "a", kind: "agent", status: "running" }),
          task({ task_id: "d", kind: "workflow", status: "completed" }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("runningCountsByConv / runningBashCountsByConv", () => {
  const map = (...ts: BackgroundTask[]): Record<string, BackgroundTask> =>
    Object.fromEntries(ts.map((t) => [t.task_id, t]));

  it("counts ALL running kinds (total) and only running bash (subset), omitting zeros", () => {
    const sessions = {
      // Bash-only conv: total 2, bash 2 → the setting's target case (total === bash).
      "conv-a": map(
        task({ task_id: "a1", kind: "bash", status: "running" }),
        task({ task_id: "a2", kind: "bash", status: "running" }),
        task({ task_id: "a3", kind: "bash", status: "completed" }), // finished, not counted
      ),
      // Mixed conv: total 2 (1 bash + 1 workflow), bash 1 → NOT bash-only.
      "conv-b": map(
        task({ task_id: "b1", kind: "bash", status: "running" }),
        task({ task_id: "b2", kind: "workflow", status: "running" }),
      ),
      // Non-bash conv: total 1 (a sub-agent), bash 0.
      "conv-c": map(task({ task_id: "c1", kind: "agent", status: "running" })),
      // Idle conv: nothing running → omitted from BOTH maps.
      "conv-d": map(task({ task_id: "d1", kind: "bash", status: "completed" })),
    };

    expect(runningCountsByConv(sessions)).toEqual({ "conv-a": 2, "conv-b": 2, "conv-c": 1 });
    expect(runningBashCountsByConv(sessions)).toEqual({ "conv-a": 2, "conv-b": 1 });
    // conv-c (non-bash) and conv-d (idle) are absent from the bash map.
    expect(runningBashCountsByConv(sessions)["conv-c"]).toBeUndefined();
    expect(runningBashCountsByConv(sessions)["conv-d"]).toBeUndefined();
  });

  it("Monitor is local_bash on the wire but kind:'monitor' → NOT counted as a bash command", () => {
    const sessions = {
      "conv-a": map(task({ task_id: "m", kind: "monitor", status: "running" })),
    };
    expect(runningCountsByConv(sessions)).toEqual({ "conv-a": 1 });
    expect(runningBashCountsByConv(sessions)).toEqual({}); // monitor is not bash
  });

  it("both are empty objects when nothing runs anywhere", () => {
    expect(runningCountsByConv({})).toEqual({});
    expect(runningBashCountsByConv({})).toEqual({});
  });
});

// Task 9ab0edf7 (round 3): the task an Agent launch card / fold atom stands for.
describe("launchTask", () => {
  const woken = task({ task_id: "agentA", tool_use_id: "tu-send", agent_id: "agentA", woken_by: "tu-send" });

  it("is the task keyed on the launch id when there is one", () => {
    const own = task({ task_id: "x", tool_use_id: "tu-launch" });
    expect(launchTask({ x: own, agentA: woken }, "tu-launch", "agentA")).toBe(own);
  });

  it("falls back to the woken task of the agent this launch gave its OWN id to", () => {
    expect(launchTask({ agentA: woken }, "tu-launch", "agentA")).toBe(woken);
  });

  it("never adopts another agent's task, nor a task that is not a wake", () => {
    expect(launchTask({ agentA: woken }, "tu-launch", "agentB")).toBeUndefined();
    expect(launchTask({ agentA: woken }, "tu-launch", null)).toBeUndefined();
    const plain = task({ task_id: "agentA", tool_use_id: "tu-elsewhere", agent_id: "agentA" });
    expect(launchTask({ agentA: plain }, "tu-launch", "agentA")).toBeUndefined();
    expect(launchTask(undefined, "tu-launch", "agentA")).toBeUndefined();
  });
});
