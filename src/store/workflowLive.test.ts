import { describe, expect, it, beforeEach } from "vitest";
import type { BackgroundTask } from "../ipc/client";
import { foldProgress, parseWfProgress, useWorkflowLiveStore, type WfLive } from "./workflowLive";

function wfTask(over: Partial<BackgroundTask> & { task_id: string }): BackgroundTask {
  return {
    kind: "workflow",
    tool_use_id: "t",
    label: "wf",
    command: null,
    subagent_type: null,
    model: null,
    agent_id: null,
    status: "running",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: null,
    ...over,
  };
}

describe("parseWfProgress", () => {
  it("splits '<phase>: <label>'", () => {
    expect(parseWfProgress("Research: r-alpha")).toEqual({ phase: "Research", label: "r-alpha" });
  });
  it("handles a label containing colons", () => {
    expect(parseWfProgress("Build: backend: services")).toEqual({
      phase: "Build",
      label: "backend: services",
    });
  });
  it("phase only (no colon)", () => {
    expect(parseWfProgress("Synthesize")).toEqual({ phase: "Synthesize", label: null });
  });
  it("empty → null", () => {
    expect(parseWfProgress("   ")).toBeNull();
  });
});

describe("foldProgress", () => {
  const empty: WfLive = { phases: [], startedAt: null };

  it("carries startedAt through a change", () => {
    const seeded: WfLive = { phases: [], startedAt: 1234 };
    const s = foldProgress(seeded, "Research: a");
    expect(s.startedAt).toBe(1234);
  });

  it("accumulates agents per phase, in first-seen order, deduped", () => {
    let s = empty;
    s = foldProgress(s, "Research: a");
    s = foldProgress(s, "Research: b");
    s = foldProgress(s, "Verify: c");
    expect(s.phases.map((p) => p.title)).toEqual(["Research", "Verify"]);
    expect(s.phases[0].labels).toEqual(["a", "b"]);
    expect(s.phases[1].labels).toEqual(["c"]);
  });

  it("is idempotent on a duplicate (phase,label) — returns the SAME object (no churn)", () => {
    let s = foldProgress(empty, "Research: a");
    const before = s;
    s = foldProgress(s, "Research: a"); // re-delivery
    expect(s).toBe(before);
  });

  it("records a phase even when the tick carries no label", () => {
    const s = foldProgress(empty, "Research");
    expect(s.phases).toEqual([{ title: "Research", labels: [] }]);
  });
});

describe("useWorkflowLiveStore.record", () => {
  beforeEach(() => useWorkflowLiveStore.getState().clear());

  it("accumulates while running, ignores non-workflow kinds", () => {
    const { record } = useWorkflowLiveStore.getState();
    record("c", wfTask({ task_id: "w", progress: "Research: a" }));
    record("c", wfTask({ task_id: "w", kind: "bash", progress: "ignored" }));
    expect(useWorkflowLiveStore.getState().runs["c"]["w"].phases[0].labels).toEqual(["a"]);
  });

  it("stamps startedAt on first sight and keeps it stable across ticks", () => {
    const { record } = useWorkflowLiveStore.getState();
    // task_started arrives with no progress yet → an entry (with a start time) still appears,
    // so the live view's run timer can start immediately.
    record("c", wfTask({ task_id: "w" }));
    const first = useWorkflowLiveStore.getState().runs["c"]?.["w"];
    expect(first).toBeDefined();
    expect(typeof first.startedAt).toBe("number");
    record("c", wfTask({ task_id: "w", progress: "Research: a" }));
    // A later tick must NOT reset the start time.
    expect(useWorkflowLiveStore.getState().runs["c"]["w"].startedAt).toBe(first.startedAt);
  });

  it("purges the run's entry once it reaches a terminal status (bounds memory)", () => {
    const { record } = useWorkflowLiveStore.getState();
    record("c", wfTask({ task_id: "w", progress: "Research: a" }));
    expect(useWorkflowLiveStore.getState().runs["c"]?.["w"]).toBeDefined();
    record("c", wfTask({ task_id: "w", status: "completed" }));
    expect(useWorkflowLiveStore.getState().runs["c"]?.["w"]).toBeUndefined();
  });
});
