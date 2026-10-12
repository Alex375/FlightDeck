import { describe, expect, it } from "vitest";
import { pickOutputView } from "./taskOutputView";

const base = { text: null as string | null, loading: false, err: null as string | null, hasPath: true, running: false };

describe("pickOutputView", () => {
  it("shows the content as soon as a non-empty read lands", () => {
    expect(pickOutputView({ ...base, text: "line1\nline2" })).toBe("output");
    // ...even while a re-poll is in flight, and even after the task finished.
    expect(pickOutputView({ ...base, text: "x", loading: true })).toBe("output");
    expect(pickOutputView({ ...base, text: "x", running: false })).toBe("output");
  });

  it("shows loading only while the FIRST read (text still null) is in flight", () => {
    expect(pickOutputView({ ...base, text: null, loading: true })).toBe("loading");
    // An empty file already read is NOT 'loading' even if a re-poll is running.
    expect(pickOutputView({ ...base, text: "", loading: true, running: true })).toBe("empty-running");
  });

  it("a re-poll after a completed read never flips back to 'loading' (no flicker)", () => {
    // A still-empty output (absent so far) re-polled every few seconds used to alternate
    // between "Loading output…" and "no output yet" on each tick.
    expect(pickOutputView({ ...base, text: null, loading: true, loaded: true, running: true })).toBe("empty-running");
    expect(pickOutputView({ ...base, text: null, loading: true, loaded: true, running: false })).toBe("unloaded");
  });

  it("surfaces a read error", () => {
    expect(pickOutputView({ ...base, err: "boom" })).toBe("error");
  });

  it("reports 'unavailable' when the output path is unknown (resumed conversation)", () => {
    expect(pickOutputView({ ...base, hasPath: false })).toBe("unavailable");
  });

  it("while running, both a null and an empty read read as 'empty-running'", () => {
    expect(pickOutputView({ ...base, text: null, running: true })).toBe("empty-running");
    expect(pickOutputView({ ...base, text: "", running: true })).toBe("empty-running");
  });

  it("a RUNNING task with no output path yet is 'empty-running', NOT 'unavailable'", () => {
    // The path lands a beat after task_started, and a Monitor's start tool_result may
    // never carry the marker — a live watch must not show "conversation rouverte".
    expect(pickOutputView({ ...base, hasPath: false, running: true })).toBe("empty-running");
  });

  it("DISTINGUISHES a finished EMPTY file from an absent one — the core fix", () => {
    // "" = the file is there and empty → genuinely produced no output.
    expect(pickOutputView({ ...base, text: "", running: false })).toBe("empty-done");
    // null = absent/unreadable → we don't have it, NOT "no output".
    expect(pickOutputView({ ...base, text: null, running: false })).toBe("unloaded");
  });
});
