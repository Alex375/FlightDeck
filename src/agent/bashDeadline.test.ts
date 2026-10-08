import { describe, it, expect } from "vitest";
import type { BackgroundTask } from "../ipc/client";
import {
  fmtLimit,
  fmtTimeLeft,
  stopCauseText,
  stopNoticeDue,
  taskStoppedDetail,
  timeLeftMs,
} from "./bashDeadline";

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  task_id: "b1",
  kind: "bash",
  tool_use_id: "tu",
  label: "dev server",
  command: "pnpm dev",
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
  woken_by: null,
  backgrounded: true,
  ambient: false,
  owned_by_subagent: false,
  time_limit_ms: 1_800_000,
  deadline_at_ms: 10_000_000,
  stop_cause: null,
  ...over,
});

describe("timeLeftMs", () => {
  it("counts down to the deadline of a running command, never below zero", () => {
    expect(timeLeftMs(task(), 10_000_000 - 90_000)).toBe(90_000);
    expect(timeLeftMs(task(), 10_000_000 + 5_000)).toBe(0);
  });

  it("is null without a deadline or once the command ended", () => {
    expect(timeLeftMs(task({ deadline_at_ms: null }), 0)).toBeNull();
    expect(timeLeftMs(task({ status: "completed" }), 0)).toBeNull();
  });
});

describe("fmtLimit", () => {
  it("states a limit the way a person would", () => {
    expect(fmtLimit(1_800_000)).toBe("30 min");
    expect(fmtLimit(7_200_000)).toBe("2 h");
    expect(fmtLimit(5_400_000)).toBe("1 h 30 min");
    expect(fmtLimit(45_000)).toBe("45 s");
  });
});

describe("fmtTimeLeft", () => {
  it("rounds up to the minute so a live command never reads 0 min", () => {
    expect(fmtTimeLeft(29 * 60_000 + 1)).toBe("30 min");
    expect(fmtTimeLeft(60_000)).toBe("1 min");
    expect(fmtTimeLeft(59_999)).toBe("< 1 min");
    expect(fmtTimeLeft(0)).toBe("< 1 min");
  });

  it("switches to hours past 60 min", () => {
    expect(fmtTimeLeft(65 * 60_000)).toBe("1 h 05");
    expect(fmtTimeLeft(120 * 60_000)).toBe("2 h 00");
  });
});

describe("stopCauseText", () => {
  it("names each cause, with the limit when known", () => {
    expect(stopCauseText("deadline", 1_800_000)).toBe("reached its 30 min time limit");
    expect(stopCauseText("deadline", null)).toBe("reached its background time limit");
    expect(stopCauseText("memory_pressure", null)).toBe("the system ran low on memory");
    expect(stopCauseText("worker_restart", null)).toBe("its worker process restarted");
    expect(stopCauseText(null, 1_800_000)).toBeNull();
  });
});

describe("taskStoppedDetail", () => {
  it("builds the line other agents read, and explains the limit", () => {
    const d = taskStoppedDetail(
      task({
        status: "stopped",
        stop_cause: "deadline",
        summary: 'Background command "dev server" was stopped after reaching its background time limit',
        output_file: "/tmp/b1.output",
      }),
    );
    expect(d.message).toBe("Background command stopped: dev server — reached its 30 min time limit");
    expect(d.heading).toBe("Background command stopped");
    expect(d.reason).toBe("reached its 30 min time limit");
    expect(d.detail).toContain("2 h at most");
    expect(d.detail).toContain("output: /tmp/b1.output");
  });

  it("falls back to the command when the task has no name", () => {
    const d = taskStoppedDetail(task({ status: "stopped", stop_cause: "memory_pressure", label: null }));
    expect(d.label).toBe("pnpm dev");
    expect(d.message).toBe("Background command stopped: pnpm dev — the system ran low on memory");
  });
});

describe("stopNoticeDue", () => {
  it("waits for the snapshot that names the cause, then raises once", () => {
    const seen = new Set<string>();
    expect(stopNoticeDue(seen, task())).toBe(false);
    // `task_updated{killed}` lands first, without a cause.
    expect(stopNoticeDue(seen, task({ status: "stopped" }))).toBe(false);
    expect(stopNoticeDue(seen, task({ status: "stopped", stop_cause: "deadline" }))).toBe(true);
    expect(stopNoticeDue(seen, task({ status: "stopped", stop_cause: "deadline" }))).toBe(false);
  });

  it("stays quiet for the user's own Stop", () => {
    expect(stopNoticeDue(new Set(), task({ status: "stopped", stop_cause: null }))).toBe(false);
  });
});
