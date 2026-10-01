import { describe, it, expect } from "vitest";
import {
  effortLabel,
  EFFORT_LABELS,
  fmtDuration,
  isDetachedAgentAck,
  agentIdFromResult,
  isDetachedAgentTask,
  isWokenRunLive,
  launchAgentId,
  reportsFailure,
  runIdFromResult,
  shortModel,
  taskIdFromResult,
} from "./subagentMeta";
import type { BackgroundTask } from "../ipc/client";

describe("isDetachedAgentTask", () => {
  const agent = (over: Partial<BackgroundTask>): BackgroundTask => ({
    task_id: "a1",
    kind: "agent",
    tool_use_id: null,
    label: null,
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
    woken_by: null,
    ...over,
  });
  const bg = new Set(["tu-bg"]);

  it("is a detached launch when its Agent tool_use is in the background set", () => {
    expect(isDetachedAgentTask(agent({ tool_use_id: "tu-bg" }), bg)).toBe(true);
  });

  it("is foreground when its launch is not detached", () => {
    expect(isDetachedAgentTask(agent({ tool_use_id: "tu-fg" }), bg)).toBe(false);
    expect(isDetachedAgentTask(agent({ tool_use_id: null }), bg)).toBe(false);
  });

  // Task 9ab0edf7: after a reload between launch and wake, the woken task carries the
  // SendMessage's tool_use_id — never in the set — and used to read as foreground.
  it("is detached when woken by SendMessage, whatever its tool_use_id", () => {
    expect(isDetachedAgentTask(agent({ tool_use_id: "tu-send", woken_by: "tu-send" }), bg)).toBe(true);
    expect(isDetachedAgentTask(agent({ tool_use_id: "tu-fg", woken_by: "tu-send" }), bg)).toBe(true);
  });

  // Option A of the review: while a woken run is live the AgentBar owns it, so the inline
  // card of a foreground-launched agent steps aside — and comes back once it settles.
  it("isWokenRunLive holds only while a woken run is running", () => {
    expect(isWokenRunLive(agent({ woken_by: "tu-send", status: "running" }))).toBe(true);
    expect(isWokenRunLive(agent({ woken_by: "tu-send", status: "completed" }))).toBe(false);
    expect(isWokenRunLive(agent({ woken_by: null, status: "running" }))).toBe(false);
    expect(isWokenRunLive(undefined)).toBe(false);
  });
});

describe("agentIdFromResult", () => {
  it("skips the 2.1.286 ack's 'agentId below' preamble and reads the real id", () => {
    const ack =
      "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n" +
      "agentId: a68e26aa615c9f436 (internal ID - do not mention to user.)";
    expect(agentIdFromResult([{ type: "text", text: ack }])).toBe("a68e26aa615c9f436");
  });

  it("reads the older ack, the SendMessage JSON result and a transcript path", () => {
    expect(agentIdFromResult("Async agent launched successfully.\nagentId: abc123\nworking")).toBe("abc123");
    expect(
      agentIdFromResult('{"success":true,"message":"Resuming agent a68e26a","resumedAgentId":"a68e26aa615c9f436"}'),
    ).toBe("a68e26aa615c9f436");
    expect(agentIdFromResult('{"agent_id": "x_1"}')).toBe("x_1");
    expect(agentIdFromResult("see /p/subagents/agent-deadbeef.jsonl")).toBe("deadbeef");
  });

  it("returns null when no id is named", () => {
    expect(agentIdFromResult("The agentId identifies each sub-agent.")).toBeNull();
    expect(agentIdFromResult(undefined)).toBeNull();
  });

  // A foreground agent's result is its free-prose report, with the CLI's trailer appended.
  it("reads the CLI trailer of a foreground report that names other 'agent_id:' tokens first", () => {
    const report = "The model has `agent_id: Option<String>` and `resolveAgentId:168`.\n\nagentId: a87dab34494f95f13 (use SendMessage with to: 'a87dab34494f95f13' to continue this agent)";
    expect(agentIdFromResult(report)).toBe("a87dab34494f95f13");
    // Trailer not at a line start: still the LAST labelled id.
    expect(agentIdFromResult("type { agentId: string } — agentId: a87dab34494f95f13 (use SendMessage")).toBe("a87dab34494f95f13");
    // '=' is no separator the CLI writes: prose like 'agent_id = Some(id)' is not an id.
    expect(agentIdFromResult("set agent_id = Some(task_id). agentId: abc (use SendMessage")).toBe("abc");
  });
});

// Task 9ab0edf7 (review round 3): a launch is tied to an agent only by the id the CLI gives
// it in that launch's own result — never by an id its report merely mentions.
describe("launchAgentId", () => {
  it("reads the ack line and the foreground trailer", () => {
    expect(launchAgentId("Async agent launched successfully. (… the agentId below …)\nagentId: a68e26aa615c9f436 (internal")).toBe(
      "a68e26aa615c9f436",
    );
    expect(launchAgentId("Report.\n\nagentId: a87d (use SendMessage with to: 'a87d')")).toBe("a87d");
  });

  it("reads a trailer sent as its OWN block (blocks join by newline, not space)", () => {
    const content = [
      { type: "text", text: "The ack looks like:\nagentId: aaaa (internal ID…)" },
      { type: "text", text: "agentId: bbbb (use SendMessage with to: 'bbbb')" },
    ];
    expect(launchAgentId(content)).toBe("bbbb");
    expect(agentIdFromResult(content)).toBe("bbbb");
  });

  it("ignores ids a report merely mentions (prose, paths, JSON)", () => {
    expect(launchAgentId("Read subagents/agent-a68e26aa615c9f436.jsonl — helper (agentId: a68e) done")).toBeNull();
    expect(launchAgentId('{"success":true,"resumedAgentId":"a68e"}')).toBeNull();
    expect(launchAgentId(undefined)).toBeNull();
  });

  it("is memoised per content object", () => {
    const content = [{ type: "text", text: "agentId: cafe" }];
    expect(launchAgentId(content)).toBe("cafe");
    (content[0] as { text: string }).text = "agentId: other"; // same object: cached answer
    expect(launchAgentId(content)).toBe("cafe");
  });
});

describe("reportsFailure", () => {
  it("is true only for an explicit success:false body", () => {
    expect(reportsFailure('{"success":false,"message":"Agent x was stopped by the user"}')).toBe(true);
    expect(reportsFailure([{ type: "text", text: '{"success":false,"message":"no"}' }])).toBe(true);
    expect(reportsFailure('{"success":true,"message":"Resuming agent x"}')).toBe(false);
    expect(reportsFailure("Agent x was stopped (completed); resumed it")).toBe(false);
    expect(reportsFailure('the reply mentions "success": false in prose')).toBe(false);
    expect(reportsFailure(undefined)).toBe(false);
  });
});

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

  it("ultracode outranks the raw effort", () => {
    expect(effortLabel("high", true)).toBe("Ultra code");
    expect(effortLabel("xhigh", true)).toBe("Ultra code");
    // ultracode flag is reported even with no separate effort string
    expect(effortLabel(null, true)).toBe("Ultra code");
  });

  it("labels the max tier", () => {
    expect(effortLabel("max")).toBe("Max");
  });

  it("falls through unrecognised effort strings (forward-compat)", () => {
    expect(effortLabel("banana")).toBe("banana");
  });

  it("EFFORT_LABELS covers exactly the gauge's levels", () => {
    expect(Object.keys(EFFORT_LABELS).sort()).toEqual(
      ["high", "low", "max", "medium", "ultra", "ultracode", "xhigh"],
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

describe("taskIdFromResult", () => {
  it("parses the background task id from the Workflow ack — the execution a card belongs to", () => {
    const ack =
      "Workflow launched in background. Task ID: wenji2gyo\nSummary: s\nRun ID: wf_cb719d53-406\n";
    expect(taskIdFromResult(ack)).toBe("wenji2gyo");
    expect(taskIdFromResult([{ type: "text", text: ack }] as never)).toBe("wenji2gyo");
  });

  it("returns null when the ack carries none", () => {
    expect(taskIdFromResult("Run ID: wf_x")).toBeNull();
    expect(taskIdFromResult(undefined)).toBeNull();
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
