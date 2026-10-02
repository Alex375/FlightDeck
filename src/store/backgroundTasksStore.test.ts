import { describe, it, expect, beforeEach } from "vitest";
import type { BackgroundTask } from "../ipc/client";
import {
  backgroundWorkSinceFor,
  isBackgroundActivity,
  runningCountFor,
  orderBashTasks,
  orderMonitorTasks,
  orderWorkflowTasks,
  runningCountsByConv,
  runningBashCountsByConv,
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
    backgrounded: null,
    ambient: false,
    owned_by_subagent: false,
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

// REGRESSION (CRM 5f971fbe): the CLI registers a task for FOREGROUND work too (a foreground
// sub-agent, a foreground Bash past ~2 s — on the main thread or inside a sub-agent) and for
// housekeeping (`ambient`). Neither is background work: counted, they showed phantom "Bash"
// rows and could hold a finished conversation green with no "done" notification.
describe("isBackgroundActivity — foreground and ambient tasks are not background work", () => {
  const map = (...ts: BackgroundTask[]): Record<string, BackgroundTask> =>
    Object.fromEntries(ts.map((t) => [t.task_id, t]));
  const sessions = {
    "conv-a": map(
      task({ task_id: "fg", kind: "bash", backgrounded: false }),
      task({ task_id: "sub-fg", kind: "bash", backgrounded: false, owned_by_subagent: true }),
      task({ task_id: "dream", kind: "other", ambient: true }),
      task({ task_id: "fg-agent", kind: "agent", backgrounded: false }),
    ),
  };

  it("keeps them out of every count, bar and the 'working since' clock", () => {
    expect(runningCountsByConv(sessions)).toEqual({});
    expect(runningBashCountsByConv(sessions)).toEqual({});
    expect(runningCountFor(sessions, "conv-a")).toBe(0);
    expect(orderBashTasks(sessions["conv-a"])).toEqual([]);
    expect(
      backgroundWorkSinceFor(sessions, { "conv-a": { fg: 1, "sub-fg": 2, dream: 3 } }, "conv-a"),
    ).toBeNull();
  });

  it("counts real background work, moved-to-background tasks and tasks the CLI said nothing about", () => {
    expect(isBackgroundActivity(task({ backgrounded: true }))).toBe(true);
    // A Workflow / an older CLI carries no flag: background, as before the flag existed.
    expect(isBackgroundActivity(task({ backgrounded: null }))).toBe(true);
    // A sub-agent's own background Bash is still this session's background work.
    expect(
      isBackgroundActivity(task({ kind: "bash", backgrounded: true, owned_by_subagent: true })),
    ).toBe(true);
    expect(isBackgroundActivity(task({ backgrounded: true, status: "completed" }))).toBe(false);
  });

  it("a flag change (moved to the background, ambient flip) is not deduped away", () => {
    useBackgroundTasksStore.getState().clear();
    const { applyTask } = useBackgroundTasksStore.getState();
    applyTask("conv-a", task({ backgrounded: false }));
    applyTask("conv-a", task({ backgrounded: true }));
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"].backgrounded).toBe(true);
    applyTask("conv-a", task({ backgrounded: true, ambient: true }));
    expect(useBackgroundTasksStore.getState().sessions["conv-a"]["tk1"].ambient).toBe(true);
  });
});
