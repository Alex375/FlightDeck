import { describe, it, expect } from "vitest";
import { failureNoticeDue } from "./taskFailureDedup";
import type { BackgroundTask, BackgroundTaskStatus } from "./client";

const snap = (status: BackgroundTaskStatus): BackgroundTask => ({
  task_id: "agentX",
  kind: "agent",
  tool_use_id: "tu",
  label: null,
  command: null,
  subagent_type: null,
  model: null,
  agent_id: null,
  status,
  progress: null,
  tokens: null,
  tool_uses: null,
  duration_ms: null,
  summary: null,
  output_file: null,
  woken_by: null,
});

describe("failureNoticeDue", () => {
  it("raises once per failed run, despite re-emitted snapshots", () => {
    const seen = new Set<string>();
    expect(failureNoticeDue(seen, snap("running"))).toBe(false);
    expect(failureNoticeDue(seen, snap("failed"))).toBe(true);
    expect(failureNoticeDue(seen, snap("failed"))).toBe(false);
  });

  // Task 9ab0edf7 (review): a sub-agent woken by SendMessage re-uses its task_id — its second
  // run failing used to be swallowed by a per-task_id de-dup that was never reset.
  it("raises again when a woken run of the same task fails", () => {
    const seen = new Set<string>();
    failureNoticeDue(seen, snap("failed"));
    expect(failureNoticeDue(seen, snap("running"))).toBe(false);
    expect(failureNoticeDue(seen, snap("failed"))).toBe(true);
  });

  it("never raises for a completed or stopped task", () => {
    const seen = new Set<string>();
    expect(failureNoticeDue(seen, snap("completed"))).toBe(false);
    expect(failureNoticeDue(seen, snap("stopped"))).toBe(false);
  });
});
