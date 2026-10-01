import { describe, it, expect } from "vitest";
import {
  effortLabel,
  EFFORT_LABELS,
  fmtDuration,
  isDetachedAgentAck,
  runIdFromResult,
  shortModel,
} from "./subagentMeta";

describe("fmtDuration", () => {
  it("formats ms, seconds, then minutes + seconds", () => {
    expect(fmtDuration(850)).toBe("850ms");
    expect(fmtDuration(6300)).toBe("6.3s");
    expect(fmtDuration(46_000)).toBe("46s");
    expect(fmtDuration(220_000)).toBe("3m 40s");
  });

  it("never prints an impossible 60 seconds", () => {
    expect(fmtDuration(119_600)).toBe("2m 00s");
    expect(fmtDuration(179_700)).toBe("3m 00s");
  });
});

describe("effortLabel", () => {
  it("maps each CLI effort level to its display label", () => {
    expect(effortLabel("low")).toBe("Low");
    expect(effortLabel("medium")).toBe("Medium");
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("xhigh")).toBe("Extra");
  });

  it("returns null when the effort is unknown (no read-back yet)", () => {
    expect(effortLabel(null)).toBeNull();
    expect(effortLabel(undefined)).toBeNull();
    expect(effortLabel("")).toBeNull();
  });

  it("never folds Ultracode into the label — it is a tint, not text", () => {
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("xhigh")).toBe("Extra");
  });

  it("labels the max tier", () => {
    expect(effortLabel("max")).toBe("Max");
  });

  it("falls through unrecognised effort strings (forward-compat)", () => {
    expect(effortLabel("banana")).toBe("banana");
  });

  it("EFFORT_LABELS covers exactly the gauge's levels", () => {
    expect(Object.keys(EFFORT_LABELS).sort()).toEqual(
      ["high", "low", "max", "medium", "ultra", "xhigh"],
    );
  });
});

describe("shortModel", () => {
  it("strips the claude- prefix, date suffix and bracket tags", () => {
    expect(shortModel("claude-opus-4-8[1m]")).toBe("opus-4-8");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });
});

describe("runIdFromResult", () => {
  // The real ack the Workflow tool returns (captured verbatim from a live run).
  const ack =
    'Workflow launched in background. Task ID: wenji2gyo\n' +
    'Summary: verify the fixes\n' +
    'Transcript dir: /Users/x/.claude/projects/p/s/subagents/workflows/wf_cb719d53-406\n' +
    'Script file: /Users/x/.claude/projects/p/s/workflows/scripts/verify-wf_cb719d53-406.js\n' +
    'Run ID: wf_cb719d53-406\n';

  it("parses the wf_ run id from the 'Run ID:' line", () => {
    expect(runIdFromResult(ack)).toBe("wf_cb719d53-406");
  });

  it("reads content delivered as an array of text blocks", () => {
    expect(runIdFromResult([{ type: "text", text: ack }] as never)).toBe("wf_cb719d53-406");
  });

  it("prefixes a bare run id with wf_", () => {
    expect(runIdFromResult("Run ID: cb719d53-406")).toBe("wf_cb719d53-406");
  });

  it("falls back to a wf_ token in a path when there is no 'Run ID' line", () => {
    expect(runIdFromResult("Transcript dir: /p/subagents/workflows/wf_abc12-9")).toBe("wf_abc12-9");
  });

  it("returns null when nothing matches", () => {
    expect(runIdFromResult("no id here")).toBeNull();
    expect(runIdFromResult(undefined)).toBeNull();
    expect(runIdFromResult("")).toBeNull();
  });
});

describe("isDetachedAgentAck", () => {
  // The real ack a detached (background) sub-agent returns at launch (captured verbatim).
  const ack =
    "Async agent launched successfully.\n" +
    "agentId: ad078355d9f89e131 (internal ID - do not mention to user.)\n" +
    "The agent is working in the background. You will be notified automatically when it completes.\n" +
    "output_file: /private/tmp/claude-501/x/tasks/ad078355d9f89e131.output\n";

  it("matches the detached-launch ack (string)", () => {
    expect(isDetachedAgentAck(ack)).toBe(true);
  });

  it("matches when delivered as an array of text blocks", () => {
    expect(isDetachedAgentAck([{ type: "text", text: ack }] as never)).toBe(true);
  });

  it("stays robust if the binary drops ONE marker (needs 2 of 3)", () => {
    // launch phrase + output_file, no "notified…" sentence → still detached.
    expect(isDetachedAgentAck("Async agent launched successfully.\noutput_file: /t/tasks/x.output")).toBe(true);
    // output_file + notify, launch phrase reworded → still detached.
    expect(
      isDetachedAgentAck("Agent started.\noutput_file: /t/tasks/x.output\nYou will be notified automatically when it completes."),
    ).toBe(true);
  });

  // Regression guard for the review's confirmed false-positive: a FOREGROUND sub-agent's
  // free-prose output that merely MENTIONS an agent id and background work must NOT be taken
  // for a launch ack — folding it would silently hide the foreground card + transcript.
  it("does NOT match foreground prose that only mentions agentId + background (single loose marker)", () => {
    expect(
      isDetachedAgentAck("The agentId is how we track sub-agents while they are working in the background."),
    ).toBe(false);
    expect(isDetachedAgentAck("agentId: abc\nThe agent is working in the background.")).toBe(false);
  });

  it("does NOT match a single launch marker on its own (needs 2)", () => {
    expect(isDetachedAgentAck("Async agent launched successfully.")).toBe(false);
    expect(isDetachedAgentAck("output_file: /tmp/x/tasks/abc.output")).toBe(false);
  });

  it("does NOT match a foreground sub-agent's final output", () => {
    expect(isDetachedAgentAck("Here is the summary of the supervisor module: …")).toBe(false);
    expect(isDetachedAgentAck("agentId mentioned but no background phrase")).toBe(false);
  });

  it("returns false for empty / missing content", () => {
    expect(isDetachedAgentAck(undefined)).toBe(false);
    expect(isDetachedAgentAck("")).toBe(false);
    expect(isDetachedAgentAck(null as never)).toBe(false);
  });
});
