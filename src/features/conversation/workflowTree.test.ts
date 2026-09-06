import { describe, expect, it } from "vitest";
import type { ConversationItem, WorkflowJournalAgent } from "../../ipc/client";
import type { OrderedLabel } from "../../store/workflowLive";
import {
  deriveActivity,
  groupAgentsByPhase,
  matchQuality,
  toolActivityLabel,
  zipAgentsToLabels,
  type LiveAgent,
} from "./workflowTree";

const ag = (agentId: string, done = false): WorkflowJournalAgent => ({ agentId, done });
const lbl = (label: string, phase: string): OrderedLabel => ({ label, phase });

describe("zipAgentsToLabels", () => {
  it("pairs agents to labels by spawn index", () => {
    const rows = zipAgentsToLabels(
      [ag("a1"), ag("a2", true)],
      [lbl("review:bugs", "Review"), lbl("review:perf", "Review")],
    );
    expect(rows).toEqual<LiveAgent[]>([
      { agentId: "a1", label: "review:bugs", phase: "Review", done: false },
      { agentId: "a2", label: "review:perf", phase: "Review", done: true },
    ]);
  });

  it("keeps a null label when there are more agents than labels", () => {
    const rows = zipAgentsToLabels([ag("a1"), ag("a2")], [lbl("only", "P")]);
    expect(rows[1]).toEqual({ agentId: "a2", label: null, phase: null, done: false });
  });

  it("keeps a null agentId for a label whose agent hasn't registered yet (queued)", () => {
    const rows = zipAgentsToLabels([ag("a1")], [lbl("l1", "P"), lbl("l2", "P")]);
    expect(rows[1]).toEqual({ agentId: null, label: "l2", phase: "P", done: false });
  });

  it("is empty when both are empty", () => {
    expect(zipAgentsToLabels([], [])).toEqual([]);
  });
});

describe("matchQuality", () => {
  it("is aligned when counts match and are non-empty", () => {
    expect(matchQuality([ag("a")], [lbl("l", "P")])).toBe("aligned");
  });
  it("is partial when counts differ", () => {
    expect(matchQuality([ag("a"), ag("b")], [lbl("l", "P")])).toBe("partial");
    expect(matchQuality([], [lbl("l", "P")])).toBe("partial");
  });
  it("is none when both empty", () => {
    expect(matchQuality([], [])).toBe("none");
  });
});

describe("groupAgentsByPhase", () => {
  const rows: LiveAgent[] = [
    { agentId: "a1", label: "r:1", phase: "Review", done: true },
    { agentId: "a2", label: "v:1", phase: "Verify", done: false },
    { agentId: "a3", label: null, phase: null, done: false }, // unlabelled
  ];

  it("buckets by phase in declared order and routes unlabelled to the fallback phase", () => {
    const out = groupAgentsByPhase(rows, ["Review", "Verify"], "Verify");
    expect(out.map((g) => g.phase)).toEqual(["Review", "Verify"]);
    expect(out[0].agents.map((a) => a.agentId)).toEqual(["a1"]);
    // a2 (Verify) + a3 (unlabelled → fallback Verify)
    expect(out[1].agents.map((a) => a.agentId)).toEqual(["a2", "a3"]);
  });

  it("keeps a declared phase with no agents (upcoming) present and empty", () => {
    const out = groupAgentsByPhase([rows[0]], ["Review", "Later"], null);
    expect(out.map((g) => g.phase)).toEqual(["Review", "Later"]);
    expect(out[1].agents).toEqual([]);
  });

  it("surfaces a wire-only phase not in the declared list rather than dropping its agents", () => {
    const only: LiveAgent[] = [{ agentId: "x", label: "e:1", phase: "Extra", done: false }];
    const out = groupAgentsByPhase(only, ["Review"], null);
    expect(out.map((g) => g.phase)).toEqual(["Review", "Extra"]);
    expect(out[1].agents.map((a) => a.agentId)).toEqual(["x"]);
  });
});

describe("toolActivityLabel", () => {
  it("appends the most meaningful target field", () => {
    expect(toolActivityLabel("Read", { file_path: "src/foo.rs" })).toBe("Read src/foo.rs");
    expect(toolActivityLabel("Bash", { command: "npm test" })).toBe("Bash npm test");
    expect(toolActivityLabel("Grep", { pattern: "TODO", path: "src" })).toBe("Grep TODO");
  });
  it("falls back to the bare tool name with no known target", () => {
    expect(toolActivityLabel("Think", { thoughts: 3 })).toBe("Think");
    expect(toolActivityLabel("X", null)).toBe("X");
  });
  it("collapses whitespace and clips a long target", () => {
    const long = "a".repeat(200);
    const out = toolActivityLabel("Bash", { command: long });
    expect(out.startsWith("Bash ")).toBe(true);
    expect(out.length).toBeLessThan(70);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("deriveActivity", () => {
  const asMsg = (blocks: unknown[]): ConversationItem =>
    ({ kind: "assistant_message", id: "m", blocks, parent_tool_use_id: null }) as ConversationItem;

  it("reports the last tool call of the last assistant turn", () => {
    const items = [
      asMsg([{ type: "text", text: "let me look" }]),
      asMsg([
        { type: "text", text: "checking" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ]),
    ];
    expect(deriveActivity(items)).toEqual({ kind: "tool", detail: "Read a.ts" });
  });

  it("falls back to the last text when the turn has no tool call", () => {
    const items = [asMsg([{ type: "text", text: "  Done   analysing\n\n" }])];
    expect(deriveActivity(items)).toEqual({ kind: "text", detail: "Done analysing" });
  });

  it("returns null when there is no assistant turn yet", () => {
    const items: ConversationItem[] = [
      { kind: "tool_result", tool_use_id: "t", content: null, is_error: false, parent_tool_use_id: null } as ConversationItem,
    ];
    expect(deriveActivity(items)).toBeNull();
    expect(deriveActivity([])).toBeNull();
  });
});
