import { describe, it, expect } from "vitest";
import { orbStateForActivity, orbStateForTaskKind, orbStateForTaskKinds, orbStateForTool } from "./orbState";
import { activityKind } from "../store/activity";
import type { SessionEntry, Turn, TimelineEntry, TodoItem, NormalizedBlock } from "../store/types";

function toolUse(id: string, name: string, input: unknown = {}): NormalizedBlock {
  return { type: "tool_use", id, name, input } as NormalizedBlock;
}

function assistantTurn(id: string, blocks: NormalizedBlock[], streaming = ""): Turn {
  return {
    id,
    role: "assistant",
    status: streaming ? "streaming" : "final",
    streamingText: streaming,
    streamingThinking: "",
    blocks,
    parentToolUseId: null,
    hasThinking: false,
  };
}

function entry(opts: {
  turns?: Record<string, Turn>;
  timeline?: TimelineEntry[];
  todos?: TodoItem[];
  state?: Record<string, unknown>;
}): SessionEntry {
  return {
    session: "s",
    state: opts.state ?? {},
    timeline: opts.timeline ?? [],
    turns: opts.turns ?? {},
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: {},
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    todos: opts.todos ?? [],
    turnSeen: true,
    seq: 0,
  } as unknown as SessionEntry;
}

/** An entry whose current main turn has `name` in flight. */
function withTool(name: string): SessionEntry {
  return entry({
    turns: { a: assistantTurn("a", [toolUse("t1", name)]) },
    timeline: [{ kind: "turn", id: "a" } as TimelineEntry],
  });
}

describe("orbStateForTool", () => {
  it("maps reading and searching tools to `searching`", () => {
    for (const n of ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"])
      expect(orbStateForTool(n), n).toBe("searching");
  });

  it("maps file edits (Claude and Codex) to `shaping`", () => {
    for (const n of ["Edit", "MultiEdit", "Write", "NotebookEdit", "ApplyPatch"])
      expect(orbStateForTool(n), n).toBe("shaping");
  });

  it("maps a foreground shell command to `listening`", () => {
    expect(orbStateForTool("Bash")).toBe("listening");
    expect(orbStateForTool("BashOutput")).toBe("listening");
  });

  it("maps sub-agents and workflows (Claude names and Codex collab phrases) to `weaving`", () => {
    for (const n of ["Agent", "Task", "Workflow", "SendMessage", "Spawning a sub-agent", "Waiting on a sub-agent", "Sub-agent: foo"])
      expect(orbStateForTool(n), n).toBe("weaving");
  });

  it("maps any MCP tool — the app's own included — to `connecting`", () => {
    expect(orbStateForTool("mcp__tosse__update_task")).toBe("connecting");
    expect(orbStateForTool("mcp__flightdeck__list_conversations")).toBe("connecting");
  });

  it("maps the plan to `solving`", () => {
    expect(orbStateForTool("TodoWrite")).toBe("solving");
    expect(orbStateForTool("ExitPlanMode")).toBe("solving");
  });

  it("falls back to `working` for everything else", () => {
    for (const n of ["Skill", "AskUserQuestion", "SomethingNew", ""]) expect(orbStateForTool(n), n).toBe("working");
  });
});

describe("orbStateForTaskKind", () => {
  it("gives shells and monitors `listening`, sub-agents and workflows `weaving`", () => {
    expect(orbStateForTaskKind("bash")).toBe("listening");
    expect(orbStateForTaskKind("monitor")).toBe("listening");
    expect(orbStateForTaskKind("agent")).toBe("weaving");
    expect(orbStateForTaskKind("workflow")).toBe("weaving");
    expect(orbStateForTaskKind("other")).toBe("working");
  });
});

describe("orbStateForTaskKinds (a backgrounding conversation's one shape)", () => {
  it("is null with nothing running", () => {
    expect(orbStateForTaskKinds([])).toBeNull();
  });

  it("weaves as soon as a sub-agent or a workflow runs, else listens to shells", () => {
    expect(orbStateForTaskKinds(["bash", "agent"])).toBe("weaving");
    expect(orbStateForTaskKinds(["workflow"])).toBe("weaving");
    expect(orbStateForTaskKinds(["bash", "monitor"])).toBe("listening");
    expect(orbStateForTaskKinds(["other"])).toBe("working");
  });
});

describe("orbStateForActivity", () => {
  it("covers every activity kind", () => {
    expect(orbStateForActivity({ kind: "compacting" })).toBe("solving");
    expect(orbStateForActivity({ kind: "writing" })).toBe("composing");
    expect(orbStateForActivity({ kind: "thinking" })).toBe("working");
    expect(orbStateForActivity({ kind: "todo" })).toBe("working");
    expect(orbStateForActivity({ kind: "tool", name: "Read" })).toBe("searching");
  });
});

describe("activityKind (the classification the orb reads)", () => {
  it("is `thinking` without an entry or with nothing in flight", () => {
    expect(activityKind(undefined)).toEqual({ kind: "thinking" });
    expect(activityKind(entry({}))).toEqual({ kind: "thinking" });
  });

  it("names the in-flight tool", () => {
    expect(activityKind(withTool("Edit"))).toEqual({ kind: "tool", name: "Edit" });
    expect(orbStateForActivity(activityKind(withTool("Bash")))).toBe("listening");
  });

  it("puts a compaction above everything else", () => {
    const e = withTool("Read");
    (e.state as Record<string, unknown>).activity = "compacting";
    expect(activityKind(e)).toEqual({ kind: "compacting" });
  });

  it("reports a streamed reply as `writing` and a to-do's phrasing as `todo`", () => {
    const writing = entry({
      turns: { a: assistantTurn("a", [], "Here is") },
      timeline: [{ kind: "turn", id: "a" } as TimelineEntry],
    });
    expect(activityKind(writing)).toEqual({ kind: "writing" });
    const todo = entry({
      todos: [{ content: "Fix it", activeForm: "Fixing it", status: "in_progress" } as TodoItem],
    });
    expect(activityKind(todo)).toEqual({ kind: "todo" });
  });
});
