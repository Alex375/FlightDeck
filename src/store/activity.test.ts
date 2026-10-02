import { describe, it, expect } from "vitest";
import {
  COMPACTING_LABEL,
  describeActivity,
  isGenericThinking,
  cumulativeThinkingMs,
  liveBashCommand,
  toolActivityLabel,
} from "./activity";
import { THINKING_ACCRUAL_CAP_MS } from "./thinkingWords";
import type { SessionEntry, Turn, TimelineEntry, TodoItem, NormalizedBlock } from "./types";

function toolUse(id: string, name: string, input: unknown): NormalizedBlock {
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
  toolResults?: Record<string, unknown>;
  todos?: TodoItem[];
}): SessionEntry {
  return {
    session: "s",
    state: {},
    timeline: opts.timeline ?? [],
    turns: opts.turns ?? {},
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: opts.toolResults ?? {},
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    todos: opts.todos ?? [],
    turnSeen: true,
    seq: 0,
  } as unknown as SessionEntry;
}

describe("toolActivityLabel", () => {
  it("names the file for read/edit/write", () => {
    expect(toolActivityLabel("Read", { file_path: "src/App.tsx" })).toBe("Read App.tsx");
    expect(toolActivityLabel("Edit", { file_path: "a/b/middleware.ts" })).toBe("Edit middleware.ts");
    expect(toolActivityLabel("Write", { file_path: "x.ts" })).toBe("Write x.ts");
  });

  it("previews a Bash command and a Grep pattern", () => {
    expect(toolActivityLabel("Bash", { command: "pnpm test" })).toBe("Run pnpm test");
    expect(toolActivityLabel("Grep", { pattern: "TODO" })).toBe('Search "TODO"');
  });

  it("names the notebook for NotebookEdit (reads notebook_path, not file_path)", () => {
    expect(toolActivityLabel("NotebookEdit", { notebook_path: "nb/analysis.ipynb" })).toBe(
      "Edit analysis.ipynb",
    );
  });

  it("labels the remaining known tools (MultiEdit, Glob, Task, WebFetch, WebSearch, TodoWrite)", () => {
    expect(toolActivityLabel("MultiEdit", { file_path: "a/b/x.ts" })).toBe("Edit x.ts");
    expect(toolActivityLabel("Glob", { pattern: "**/*.ts" })).toBe("Find **/*.ts");
    expect(toolActivityLabel("Task", { description: "Audit auth" })).toBe("Sub-agent: Audit auth");
    // `Agent` is the current wire name of the sub-agent tool (alias of `Task`).
    expect(toolActivityLabel("Agent", { description: "Audit auth" })).toBe("Sub-agent: Audit auth");
    expect(toolActivityLabel("WebFetch", { url: "https://www.example.com/page" })).toBe(
      "Fetch example.com",
    );
    expect(toolActivityLabel("WebFetch", {})).toBe("Fetch a web page");
    expect(toolActivityLabel("WebSearch", { query: "tauri updater" })).toBe('Search "tauri updater"');
    expect(toolActivityLabel("TodoWrite", { todos: [] })).toBe("Update the plan");
    expect(toolActivityLabel("AskUserQuestion", { questions: [1, 2] })).toBe("Ask 2 questions");
    expect(toolActivityLabel("AskUserQuestion", {})).toBe("Ask a question");
  });

  it("uses the no-argument fallback when the input carries no telling field", () => {
    // What the card shows on a tool_use whose input is still streaming in (built
    // incrementally) — every arg-dependent branch must have a graceful fallback.
    expect(toolActivityLabel("Read", {})).toBe("Read a file");
    expect(toolActivityLabel("Edit", {})).toBe("Edit a file");
    expect(toolActivityLabel("Write", {})).toBe("Write a file");
    expect(toolActivityLabel("NotebookEdit", {})).toBe("Edit a notebook");
    expect(toolActivityLabel("Bash", {})).toBe("Run a command");
    expect(toolActivityLabel("Grep", {})).toBe("Search the code");
    expect(toolActivityLabel("Glob", {})).toBe("Find files");
    expect(toolActivityLabel("Task", {})).toBe("Delegate to a sub-agent");
    expect(toolActivityLabel("WebSearch", {})).toBe("Search the web");
  });

  it("trims internal whitespace and truncates a long argument with an ellipsis", () => {
    // 60-char command, over Bash's 38-char limit → sliced to 37 chars + "…" (38 total).
    const cmd = "echo " + "a".repeat(55);
    const label = toolActivityLabel("Bash", { command: cmd });
    expect(label.startsWith("Run ")).toBe(true);
    const shown = [...label.slice("Run ".length)];
    expect(shown[shown.length - 1]).toBe("…");
    expect(shown.length).toBe(38); // 37 kept chars + the ellipsis
    // Whitespace runs collapse to a single space BEFORE the length check.
    expect(toolActivityLabel("Grep", { pattern: "foo    bar" })).toBe('Search "foo bar"');
  });

  it("falls back to the tool name for unknown tools", () => {
    expect(toolActivityLabel("Frobnicate", {})).toBe("Frobnicate…");
  });

  it("names the activated skill directly", () => {
    expect(toolActivityLabel("Skill", { skill: "code-review" })).toBe("Skill : code-review");
    expect(toolActivityLabel("Skill", { skill: "code-review", args: "--fix" })).toBe(
      "Skill : code-review",
    );
    expect(toolActivityLabel("Skill", {})).toBe("Skill");
  });

  it("renders an MCP tool as `<server> : <tool>` instead of its raw wire name", () => {
    expect(toolActivityLabel("mcp__claude_ai_TOSSE__create_task", {})).toBe(
      "claude ai TOSSE : create_task",
    );
    expect(toolActivityLabel("mcp__playwright__browser_click", {})).toBe(
      "playwright : browser_click",
    );
  });
});

describe("describeActivity", () => {
  it("says the conversation is being compacted, above any tool in flight", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "a1" }],
      turns: {
        a1: {
          id: "a1",
          role: "assistant",
          parentToolUseId: null,
          status: "streaming",
          streamingText: "",
          blocks: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/App.tsx" } }],
        } as unknown as Turn,
      },
    });
    expect(describeActivity(e)).toBe("Read App.tsx");
    const compacting = { ...e, state: { activity: "compacting" } } as unknown as SessionEntry;
    expect(describeActivity(compacting)).toBe(COMPACTING_LABEL);
    expect(isGenericThinking(compacting)).toBe(false);
  });

  it("describes a tool that is in flight (no result yet)", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Read", { file_path: "src/App.tsx" })]) },
      toolResults: {},
    });
    expect(describeActivity(e)).toBe("Read App.tsx");
  });

  it("with parallel tools, shows a still-running earlier tool even if a later one finished first", () => {
    // One message batched three tools; the last block (Grep) finished first while
    // the Reads are still running. The live line must name a running Read, not fall
    // through to "Thinking…".
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: {
        t1: assistantTurn("t1", [
          toolUse("tu1", "Read", { file_path: "a.ts" }),
          toolUse("tu2", "Read", { file_path: "b.ts" }),
          toolUse("tu3", "Grep", { pattern: "TODO" }),
        ]),
      },
      toolResults: { tu3: { toolUseId: "tu3", content: "", isError: false, parentToolUseId: null } },
    });
    expect(describeActivity(e)).toBe("Read b.ts");
  });

  it("prefers the current to-do once the tool has finished", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Read", { file_path: "src/App.tsx" })]) },
      toolResults: { tu1: { toolUseId: "tu1", content: "", isError: false, parentToolUseId: null } },
      todos: [{ content: "Migrer staging", status: "in_progress", activeForm: "Migre staging" }],
    });
    expect(describeActivity(e)).toBe("Migre staging");
  });

  it("says it's writing when streaming text with no tool/todo", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [], "Voici le correctif") },
    });
    expect(describeActivity(e)).toBe("Writing a reply…");
  });

  it("never shows a FINISHED tool — no stale 'Run …' leaking into the next turn", () => {
    // The previous turn ran a Bash echo that completed; a fresh turn is starting
    // with nothing produced yet. The finished echo must NOT be shown as activity.
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Bash", { command: "echo salut" })]) },
      toolResults: { tu1: { toolUseId: "tu1", content: "salut", isError: false, parentToolUseId: null } },
    });
    expect(describeActivity(e)).toBe("Thinking…");
  });

  it("never leaks a prior turn's result-less (interrupted) tool into a new empty turn", () => {
    // The previous turn was interrupted mid-Bash (no result synthesized), then a
    // fresh assistant turn starts empty. The stranded echo must NOT reappear.
    const e = entry({
      timeline: [
        { kind: "turn", id: "t1" },
        { kind: "turn_result", id: "tr" },
        { kind: "turn", id: "u1" },
        { kind: "turn", id: "t2" },
      ],
      turns: {
        t1: { ...assistantTurn("t1", [toolUse("tu1", "Bash", { command: "echo salut" })]), status: "interrupted" },
        u1: { ...assistantTurn("u1", []), role: "user", status: "final" },
        t2: assistantTurn("t2", []),
      },
      toolResults: {}, // interrupt synthesized no result for tu1
    });
    expect(describeActivity(e)).toBe("Thinking…");
  });

  it("shows nothing-in-flight when the latest main turn is the user's just-sent message", () => {
    // Between send and the agent's first output, the previous turn's result-less
    // tool must not be surfaced.
    const e = entry({
      timeline: [
        { kind: "turn", id: "t1" },
        { kind: "turn", id: "u1" },
      ],
      turns: {
        t1: { ...assistantTurn("t1", [toolUse("tu1", "Bash", { command: "echo salut" })]), status: "interrupted" },
        u1: { ...assistantTurn("u1", []), role: "user", status: "final" },
      },
      toolResults: {},
    });
    expect(describeActivity(e)).toBe("Thinking…");
  });

  it("falls back to thinking on an empty turn, and a neutral line with no entry", () => {
    expect(describeActivity(entry({}))).toBe("Thinking…");
    expect(describeActivity(undefined)).toBe("Working…");
  });

  it("flags the generic thinking state (isGenericThinking) only when nothing concrete is in flight", () => {
    // The playful word substitution keys off this: true only in the last-resort "Thinking…" state.
    expect(isGenericThinking(entry({}))).toBe(true);
    const withTool = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Read", { file_path: "a.ts" })]) },
    });
    expect(isGenericThinking(withTool)).toBe(false);
    const writing = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [], "Voici") },
    });
    expect(isGenericThinking(writing)).toBe(false);
    expect(isGenericThinking(undefined)).toBe(false);
  });
});

describe("cumulativeThinkingMs", () => {
  it("adds the open spinner spell to the sealed total", () => {
    const e = { ...entry({}), thinkingMs: 8000, thinkingSince: 1000 } as SessionEntry;
    // now=1500 → open spell adds 1500-1000=500 to the 8000 already sealed.
    expect(cumulativeThinkingMs(e, 1500)).toBe(8500);
  });

  it("caps the live spell so a post-wake render can't spike the tier", () => {
    const e = { ...entry({}), thinkingMs: 5000, thinkingSince: 1000 } as SessionEntry;
    expect(cumulativeThinkingMs(e, 9_999_999)).toBe(5000 + THINKING_ACCRUAL_CAP_MS);
  });

  it("returns just the sealed total when no spell is open", () => {
    const e = { ...entry({}), thinkingMs: 5000, thinkingSince: null } as SessionEntry;
    expect(cumulativeThinkingMs(e, 9_999_999)).toBe(5000);
  });
});

describe("liveBashCommand", () => {
  it("returns the command of a foreground Bash in flight (no result yet)", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Bash", { command: "pnpm test" })]) },
      toolResults: {},
    });
    expect(liveBashCommand(e)).toBe("pnpm test");
  });

  it("is null when the in-flight tool is not a Bash", () => {
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Read", { file_path: "a.ts" })]) },
      toolResults: {},
    });
    expect(liveBashCommand(e)).toBeNull();
  });

  it("is null for a backgrounded Bash — its result lands immediately, so never in flight", () => {
    // A run_in_background Bash gets the "running in background" ack right away, so its
    // tool_result exists → not in flight here (it belongs in the BashBar instead).
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Bash", { command: "pnpm dev" })]) },
      toolResults: { tu1: { toolUseId: "tu1", content: "running in background", isError: false, parentToolUseId: null } },
    });
    expect(liveBashCommand(e)).toBeNull();
  });

  it("is null with no entry / an empty command", () => {
    expect(liveBashCommand(undefined)).toBeNull();
    const e = entry({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: { t1: assistantTurn("t1", [toolUse("tu1", "Bash", { command: "   " })]) },
      toolResults: {},
    });
    expect(liveBashCommand(e)).toBeNull();
  });
});
