import { describe, expect, it } from "vitest";
import type { NormalizedBlock } from "../../ipc/client";
import {
  atomsToSegments,
  atomStillRunning,
  countWorkSteps,
  flattenWork,
  groupBlocks,
  interleaveMarkers,
  isHiddenInline,
  liveVisibleStart,
  runHeader,
  splitFinalMessage,
  stepIcon,
  stepLabel,
  stepSummary,
  workStepIds,
  type BlockMarker,
  type Segment,
  type ToolStep,
} from "./toolGroup";

const mkStep = (name: string, input: unknown = {}): ToolStep => ({
  id: name,
  name,
  input: input as never,
});

const text = (t: string): NormalizedBlock => ({ type: "text", text: t });
const thinking = (t: string): NormalizedBlock => ({ type: "thinking", text: t });
const tool = (id: string, name: string, input: unknown = {}): NormalizedBlock => ({
  type: "tool_use",
  id,
  name,
  input: input as never,
});
const mkMarker = (id: string, markerKind: "notice" | "user" = "notice"): BlockMarker => ({
  type: "marker",
  markerKind,
  id,
  key: `mk-${id}`,
});

describe("groupBlocks", () => {
  it("coalesces consecutive tool_use into one run", () => {
    const segs = groupBlocks([tool("a", "Read"), tool("b", "Read"), tool("c", "Edit")]);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("run");
    if (segs[0].kind === "run") expect(segs[0].steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("splits runs around assistant prose (the boundary the user chose)", () => {
    const segs = groupBlocks([
      text("Let me explore."),
      tool("a", "Read"),
      tool("b", "Grep"),
      text("Good starting point."),
      tool("c", "Bash"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["text", "run", "text", "run"]);
    if (segs[1].kind === "run") expect(segs[1].steps).toHaveLength(2);
    if (segs[3].kind === "run") expect(segs[3].steps).toHaveLength(1);
  });

  it("thinking also breaks a run", () => {
    const segs = groupBlocks([tool("a", "Read"), thinking("hmm"), tool("b", "Read")]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "thinking", "run"]);
  });

  it("skips hidden tools without breaking the surrounding run", () => {
    const segs = groupBlocks([
      tool("a", "Read"),
      tool("bg", "Bash", { run_in_background: true }), // detached → hidden
      tool("todo", "TodoWrite"), // suppressed → hidden
      tool("b", "Edit"),
    ]);
    expect(segs).toHaveLength(1);
    if (segs[0].kind === "run") expect(segs[0].steps.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("renders a foreground sub-agent as its own segment, breaking the run", () => {
    const segs = groupBlocks([tool("a", "Read"), tool("ag", "Agent"), tool("b", "Read")]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "agent", "run"]);
    if (segs[1].kind === "agent") expect(segs[1].step.id).toBe("ag");
  });

  it("renders a model-invoked Skill as its own segment, breaking the run", () => {
    const segs = groupBlocks([
      tool("a", "Read"),
      tool("sk", "Skill", { skill: "tosse-workflow:done" }),
      tool("b", "Read"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "skill", "run"]);
    if (segs[1].kind === "skill") expect(segs[1].step.id).toBe("sk");
  });

  it("hides a detached (background) sub-agent entirely", () => {
    const segs = groupBlocks([tool("ag", "Agent", { run_in_background: true })]);
    expect(segs).toEqual([]);
  });

  it("hides an Agent flagged detached-by-ack even when its input lacks run_in_background", () => {
    // The bug: a detached agent whose live block arrived WITHOUT run_in_background. Without
    // the id set it renders inline (foreground card); with it, it's hidden like any background.
    const blocks = [tool("a", "Read"), tool("ag", "Agent"), tool("b", "Read")];
    expect(groupBlocks(blocks).map((s) => s.kind)).toEqual(["run", "agent", "run"]);
    const withSet = groupBlocks(blocks, false, new Set(["ag"]));
    // The Agent is invisible → the surrounding reads coalesce into one run, no break.
    expect(withSet).toHaveLength(1);
    if (withSet[0].kind === "run") expect(withSet[0].steps.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("backgroundToolUseIds is ignored under includeBackground (disk view keeps the record)", () => {
    const blocks = [tool("ag", "Agent")];
    const segs = groupBlocks(blocks, true, new Set(["ag"]));
    expect(segs.map((s) => s.kind)).toEqual(["agent"]);
  });

  it("drops empty text/thinking placeholders", () => {
    const segs = groupBlocks([text(""), tool("a", "Read"), thinking("")]);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("run");
  });

  it("returns no run when every tool is hidden", () => {
    const segs = groupBlocks([tool("m", "Monitor"), tool("t", "TodoWrite")]);
    expect(segs).toEqual([]);
  });

  it("includeBackground keeps Monitor / detached Bash as steps but still drops suppressed tools", () => {
    const segs = groupBlocks(
      [
        tool("a", "Read"),
        tool("m", "Monitor"),
        tool("bg", "Bash", { run_in_background: true }),
        tool("todo", "TodoWrite"), // suppressed → hidden even on the disk view
        tool("b", "Edit"),
      ],
      true,
    );
    expect(segs).toHaveLength(1);
    if (segs[0].kind === "run")
      expect(segs[0].steps.map((s) => s.id)).toEqual(["a", "m", "bg", "b"]);
  });
});

describe("isHiddenInline", () => {
  it("hides Monitor, detached tools and suppressed tools; keeps foreground tools + Workflow", () => {
    expect(isHiddenInline("Monitor", {})).toBe(true);
    expect(isHiddenInline("Bash", { run_in_background: true })).toBe(true);
    expect(isHiddenInline("TodoWrite", {})).toBe(true);
    expect(isHiddenInline("Bash", { command: "ls" })).toBe(false);
    expect(isHiddenInline("Read", { file_path: "/a.ts" })).toBe(false);
    // Workflow is NOT hidden — it renders as a persistent inline card.
    expect(isHiddenInline("Workflow", { script: "export const meta = {}" })).toBe(false);
  });
});

describe("groupBlocks — Workflow", () => {
  it("emits a dedicated `workflow` segment that breaks the surrounding run", () => {
    const segs = groupBlocks([
      tool("r", "Read", { file_path: "a.ts" }),
      tool("w", "Workflow", { description: "review", script: "x" }),
      tool("g", "Grep", { pattern: "x" }),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "workflow", "run"]);
    const wf = segs[1];
    if (wf.kind === "workflow") expect(wf.step.id).toBe("w");
  });
});

describe("groupBlocks — ExitPlanMode (proposed plan)", () => {
  it("emits a dedicated `plan` segment that breaks the surrounding run", () => {
    const segs = groupBlocks([
      tool("r", "Read", { file_path: "a.ts" }),
      tool("p", "ExitPlanMode", { plan: "# Plan\n- do a thing" }),
      tool("g", "Grep", { pattern: "x" }),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "plan", "run"]);
    const pl = segs[1];
    if (pl.kind === "plan") expect(pl.step.id).toBe("p");
  });

  it("is NOT hidden inline (must always show), unlike a background tool", () => {
    expect(isHiddenInline("ExitPlanMode", { plan: "x" })).toBe(false);
  });

  it("does not count the plan as a work step (it's a decision, not work)", () => {
    const segs = groupBlocks([tool("a", "Read"), tool("p", "ExitPlanMode", { plan: "x" })]);
    expect(countWorkSteps(segs)).toBe(1);
    expect(workStepIds(segs)).toEqual(["a"]);
  });

  it("peels a TRAILING plan (with any closing prose) into `final` so it stays in clear", () => {
    // A pending plan is the last block — the agent pauses right after ExitPlanMode. It must NOT
    // fold into the work block: the user has to see it to accept/reject.
    const { work, final } = splitFinalMessage(
      groupBlocks([
        tool("a", "Read"),
        tool("b", "Edit"),
        tool("p", "ExitPlanMode", { plan: "# Plan" }),
      ]),
    );
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final.map((s) => s.kind)).toEqual(["plan"]);
  });

  it("survives a flattenWork → atomsToSegments round-trip (plan stays its own atom)", () => {
    const work = groupBlocks([tool("a", "Read"), tool("p", "ExitPlanMode", { plan: "x" })]);
    const atoms = flattenWork(work);
    expect(atoms.map((a) => a.kind)).toEqual(["step", "plan"]);
    const back = atomsToSegments(atoms, "vis");
    expect(back.map((s) => s.kind)).toEqual(["run", "plan"]);
    const pl = back[1];
    if (pl.kind === "plan") expect(pl.step.id).toBe("p");
  });
});

describe("groupBlocks — Artifact (publish only)", () => {
  it("emits an `artifact` segment for a real publish (has file_path), breaking the run", () => {
    const segs = groupBlocks([
      tool("a", "Read"),
      tool("art", "Artifact", { file_path: "/tmp/x.html", favicon: "🎨" }),
      tool("b", "Read"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "artifact", "run"]);
    const a = segs[1];
    if (a.kind === "artifact") expect(a.step.id).toBe("art");
  });

  it("does NOT treat a file_path-less Artifact (action:list / bare url-update) as an artifact — it falls through to the run, mirroring selectArtifacts", () => {
    const list = groupBlocks([tool("l", "Artifact", { action: "list", limit: 25 })]);
    expect(list.map((s) => s.kind)).toEqual(["run"]);
    const urlUpdate = groupBlocks([tool("u", "Artifact", { url: "https://claude.ai/code/artifact/abc" })]);
    expect(urlUpdate.map((s) => s.kind)).toEqual(["run"]);
  });
});

describe("groupBlocks — in-band markers (mid-turn separator)", () => {
  it("emits a `marker` segment that breaks the run without being a step", () => {
    const segs = groupBlocks([tool("a", "Read"), mkMarker("cc"), tool("b", "Read")]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "marker", "run"]);
    const m = segs[1];
    if (m.kind === "marker") {
      expect(m.id).toBe("cc");
      expect(m.markerKind).toBe("notice");
    }
    // A marker is NOT a tool step: it doesn't inflate the run count nor the step ids.
    expect(countWorkSteps(segs)).toBe(2);
    expect(workStepIds(segs)).toEqual(["a", "b"]);
  });

  it("keeps the trailing text as the final message across an earlier marker (one round)", () => {
    const { work, final } = splitFinalMessage(
      groupBlocks([tool("a", "Read"), mkMarker("uinj", "user"), tool("b", "Edit"), text("Done.")]),
    );
    // work = run + marker + run (ONE fold), final = the closing prose only.
    expect(work.map((s) => s.kind)).toEqual(["run", "marker", "run"]);
    expect(final.map((s) => s.kind)).toEqual(["text"]);
  });

  it("peels a TRAILING marker (after the final text) into `final` so the fold is not defeated", () => {
    // A control-change bar / injected message landing right at the end of the response. Without
    // peeling markers too, final=[] would make a settled round render fully unfolded.
    const { work, final } = splitFinalMessage(
      groupBlocks([tool("a", "Read"), tool("b", "Edit"), text("Done."), mkMarker("cc")]),
    );
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final.map((s) => s.kind)).toEqual(["text", "marker"]);
  });

  it("survives a flattenWork → atomsToSegments round-trip (marker stays a non-step atom)", () => {
    const work = groupBlocks([tool("a", "Read"), mkMarker("cc"), tool("b", "Edit")]);
    const atoms = flattenWork(work);
    expect(atoms.map((a) => a.kind)).toEqual(["step", "marker", "step"]);
    const back = atomsToSegments(atoms, "vis");
    expect(back.map((s) => s.kind)).toEqual(["run", "marker", "run"]);
  });

  it("liveVisibleStart never counts a marker toward the 3-step window", () => {
    // 3 real steps + a marker: the window is the 3 steps, so nothing folds (start 0), and the
    // marker rides along in the visible region.
    const atoms = flattenWork(
      groupBlocks([tool("a", "Read"), tool("b", "Read"), mkMarker("cc"), tool("c", "Read")]),
    );
    expect(liveVisibleStart(atoms, () => false, 3)).toBe(0);
  });
});

describe("interleaveMarkers", () => {
  const blk = (id: string): NormalizedBlock => tool(id, "Read");

  it("splices a marker at its turn boundary (after: 1 → between turn 0 and turn 1)", () => {
    const out = interleaveMarkers([[blk("a")], [blk("b")]], [
      { markerKind: "notice", id: "cc", after: 1 },
    ]);
    expect(out.map((x) => ("type" in x ? x.type : "?"))).toEqual([
      "tool_use",
      "marker",
      "tool_use",
    ]);
    const m = out[1] as BlockMarker;
    expect(m.id).toBe("cc");
    expect(m.key).toBe("mk-cc");
  });

  it("emits a marker with after: 0 before the first turn's blocks", () => {
    const out = interleaveMarkers([[blk("a")]], [{ markerKind: "user", id: "u", after: 0 }]);
    expect(out.map((x) => ("type" in x ? x.type : "?"))).toEqual(["marker", "tool_use"]);
  });

  it("with no markers, returns the turns' blocks concatenated (identical to the plain stream)", () => {
    const out = interleaveMarkers([[blk("a"), blk("b")], [blk("c")]], []);
    expect(out).toEqual([blk("a"), blk("b"), blk("c")]);
  });
});

describe("runHeader", () => {
  it("uses the full label for a single step", () => {
    expect(runHeader([mkStep("Read", { file_path: "/x/App.tsx" })])).toBe("Read App.tsx");
  });

  it("summarises distinct action verbs in order", () => {
    expect(runHeader([mkStep("Read"), mkStep("Grep"), mkStep("Glob")])).toBe(
      "Read · Search · Find",
    );
  });

  it("collapses a repeated verb with ×N", () => {
    expect(runHeader([mkStep("Read"), mkStep("Read"), mkStep("Read")])).toBe("Read ×3");
    expect(runHeader([mkStep("Bash"), mkStep("Bash"), mkStep("Edit")])).toBe("Run ×2 · Edit");
  });

  it("caps the number of verb groups", () => {
    expect(
      runHeader([
        mkStep("Read"),
        mkStep("Edit"),
        mkStep("Write"),
        mkStep("Bash"),
        mkStep("Grep"),
      ]),
    ).toBe("Read · Edit · Write · Run · +1");
  });

  it("aggregates MCP tools of one server as a count", () => {
    expect(
      runHeader([
        mkStep("mcp__claude_ai_TOSSE__create_task"),
        mkStep("mcp__claude_ai_TOSSE__get_tasks"),
        mkStep("mcp__claude_ai_TOSSE__update_task"),
      ]),
    ).toBe("claude ai TOSSE · 3 tools");
  });

  it("keeps separate MCP servers apart, singularising the count", () => {
    expect(
      runHeader([
        mkStep("mcp__claude_ai_TOSSE__create_task"),
        mkStep("mcp__claude_ai_TOSSE__get_tasks"),
        mkStep("mcp__playwright__browser_click"),
      ]),
    ).toBe("claude ai TOSSE · 2 tools · playwright · 1 tool");
  });

  it("mixes native verbs and MCP server groups", () => {
    expect(
      runHeader([
        mkStep("Read"),
        mkStep("Read"),
        mkStep("mcp__claude_ai_TOSSE__create_task"),
        mkStep("mcp__claude_ai_TOSSE__get_tasks"),
        mkStep("mcp__claude_ai_TOSSE__update_task"),
      ]),
    ).toBe("Read ×2 · claude ai TOSSE · 3 tools");
  });

  it("uses the full `<server> : <tool>` label for a single MCP step", () => {
    expect(runHeader([mkStep("mcp__claude_ai_TOSSE__create_task")])).toBe(
      "claude ai TOSSE : create_task",
    );
  });
});

describe("stepIcon", () => {
  it("maps known tools, MCP tools (plug) and unknowns (cog)", () => {
    expect(stepIcon("Read")).toBe("file");
    expect(stepIcon("Skill")).toBe("wand");
    expect(stepIcon("mcp__claude_ai_TOSSE__create_task")).toBe("plug");
    expect(stepIcon("Frobnicate")).toBe("cog");
  });
});

describe("stepLabel", () => {
  it("prefers the description for Bash/Agent", () => {
    expect(stepLabel("Bash", { command: "pnpm test", description: "Run the tests" })).toBe(
      "Run the tests",
    );
    expect(stepLabel("Agent", { description: "Explore backend" })).toBe("Explore backend");
  });

  it("falls back to name+arg phrasing for plain tools", () => {
    expect(stepLabel("Read", { file_path: "/x/App.tsx" })).toBe("Read App.tsx");
    expect(stepLabel("Edit", { file_path: "/x/foo.ts" })).toBe("Edit foo.ts");
  });
});

describe("stepSummary", () => {
  it("computes +N −M for an Edit from its input", () => {
    const s = stepSummary("Edit", { old_string: "a\nb", new_string: "a\nB\nc" }, null);
    expect(s?.kind).toBe("diff");
    if (s?.kind === "diff") {
      expect(s.added).toBeGreaterThan(0);
      expect(s.removed).toBeGreaterThan(0);
    }
  });

  it("counts written lines for Write, ignoring a single trailing newline", () => {
    expect(stepSummary("Write", { content: "l1\nl2\nl3" }, null)).toEqual({
      kind: "text",
      text: "3 lines",
    });
    // A file ending in "\n" (the common case) must not be counted as one extra line.
    expect(stepSummary("Write", { content: "l1\nl2\n" }, null)).toEqual({
      kind: "text",
      text: "2 lines",
    });
  });

  it("counts result lines for Grep, null when no result", () => {
    expect(stepSummary("Grep", { pattern: "x" }, "hit1\nhit2\n\nhit3")).toEqual({
      kind: "text",
      text: "3 results",
    });
    expect(stepSummary("Grep", { pattern: "x" }, null)).toBeNull();
  });

  it("returns null for tools without a cheap summary", () => {
    expect(stepSummary("Read", { file_path: "/a" }, "x\ny")).toBeNull();
  });
});

// Build segments via groupBlocks so the helpers are tested on real shapes.
const segs = (blocks: NormalizedBlock[]): Segment[] => groupBlocks(blocks);

describe("splitFinalMessage", () => {
  it("treats the trailing text as the final message, the rest as work", () => {
    const { work, final } = splitFinalMessage(
      segs([tool("a", "Read"), tool("b", "Edit"), text("There, all done.")]),
    );
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final.map((s) => s.kind)).toEqual(["text"]);
    if (final[0].kind === "text") expect(final[0].text).toBe("There, all done.");
  });

  it("keeps an INTERMEDIATE text (followed by tools) inside work", () => {
    const { work, final } = splitFinalMessage(
      segs([text("Getting started."), tool("a", "Read"), text("Done.")]),
    );
    // Only the LAST text is the final message; the opening text stays work.
    expect(work.map((s) => s.kind)).toEqual(["text", "run"]);
    expect(final).toHaveLength(1);
    if (final[0].kind === "text") expect(final[0].text).toBe("Done.");
  });

  it("only a final message (no work) → empty work", () => {
    const { work, final } = splitFinalMessage(segs([text("Just a reply.")]));
    expect(work).toEqual([]);
    expect(final).toHaveLength(1);
  });

  it("no trailing text (ends on tools) → empty final", () => {
    const { work, final } = splitFinalMessage(segs([tool("a", "Read"), tool("b", "Bash")]));
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final).toEqual([]);
  });

  it("folds several trailing text segments together as the final message", () => {
    const { work, final } = splitFinalMessage(
      segs([tool("a", "Read"), text("First line."), text("Second line.")]),
    );
    expect(work.map((s) => s.kind)).toEqual(["run"]);
    expect(final.map((s) => s.kind)).toEqual(["text", "text"]);
  });
});

describe("countWorkSteps", () => {
  it("counts tool steps across runs PLUS sub-agents, ignoring prose/thinking", () => {
    const s = segs([
      text("intro"),
      tool("a", "Read"),
      tool("b", "Edit"),
      thinking("hmm"),
      tool("ag", "Agent"),
      tool("c", "Bash"),
    ]);
    // runs: [Read, Edit] (2) + [Bash] (1) = 3 steps, + the sub-agent (folds into the block
    // in clean-output, so it counts as work) = 4.
    expect(countWorkSteps(s)).toBe(4);
  });

  it("is zero for prose/thinking only", () => {
    expect(countWorkSteps(segs([text("a"), thinking("b")]))).toBe(0);
  });
});

describe("workStepIds", () => {
  it("lists run step ids + sub-agent ids in order, skipping prose/thinking", () => {
    const s = segs([
      text("intro"),
      tool("a", "Read"),
      tool("b", "Edit"),
      thinking("hmm"),
      tool("ag", "Agent"),
      tool("c", "Bash"),
    ]);
    expect(workStepIds(s)).toEqual(["a", "b", "ag", "c"]);
  });

  it("is empty for prose/thinking only", () => {
    expect(workStepIds(segs([text("a"), thinking("b")]))).toEqual([]);
  });
});

describe("flattenWork / atomsToSegments", () => {
  it("flattens a run into one atom per step, then reconstructs it", () => {
    const work = segs([text("intro"), tool("a", "Read"), tool("b", "Edit"), tool("ag", "Agent")]);
    const atoms = flattenWork(work);
    expect(atoms.map((a) => a.kind)).toEqual(["text", "step", "step", "agent"]);
    const back = atomsToSegments(atoms, "x");
    // The two consecutive steps re-coalesce into one run; text + agent stay separate.
    expect(back.map((s) => s.kind)).toEqual(["text", "run", "agent"]);
    if (back[1].kind === "run") expect(back[1].steps.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("gives reconstructed runs stable, prefixed keys (no remount as the fold slides)", () => {
    const atoms = flattenWork(segs([tool("a", "Read"), tool("b", "Edit")]));
    const a = atomsToSegments(atoms, "vis");
    const b = atomsToSegments(atoms.slice(1), "vis");
    expect(a[0].key).toBe("vis-run-a");
    // Losing the run's first step does re-key it — that run genuinely changed identity.
    expect(b[0].key).toBe("vis-run-b");
  });

  it("does not re-key a run when an EARLIER one folds away", () => {
    // The regression an ordinal-based key produced: the fold boundary advancing past the first
    // run renumbered the second one, so React remounted a live, untouched tool section (and
    // every step row the user had expanded inside it snapped shut).
    const atoms = flattenWork(
      segs([tool("a", "Read"), text("narration"), tool("b", "Edit"), tool("c", "Bash")]),
    );
    const wide = atomsToSegments(atoms, "vis").filter((s) => s.kind === "run");
    const narrow = atomsToSegments(atoms.slice(2), "vis").filter((s) => s.kind === "run");
    expect(wide.map((s) => s.key)).toEqual(["vis-run-a", "vis-run-b"]);
    expect(narrow.map((s) => s.key)).toEqual(["vis-run-b"]); // same run, same key
  });

  it("keeps a Skill as a non-step atom that breaks a run and round-trips", () => {
    const work = segs([tool("a", "Read"), tool("sk", "Skill", { skill: "x:done" }), tool("b", "Edit")]);
    const atoms = flattenWork(work);
    expect(atoms.map((a) => a.kind)).toEqual(["step", "skill", "step"]);
    const back = atomsToSegments(atoms, "vis");
    // The skill breaks the run: the two reads DON'T coalesce across it.
    expect(back.map((s) => s.kind)).toEqual(["run", "skill", "run"]);
    // A skill is a meta-action, not "work": it never counts as a step nor subscribes as one.
    expect(countWorkSteps(work)).toBe(2);
    expect(workStepIds(work)).toEqual(["a", "b"]);
  });
});

describe("liveVisibleStart", () => {
  const none = () => false;
  it("keeps the last `window` steps visible when nothing runs", () => {
    const atoms = flattenWork(segs([tool("a", "Read"), tool("b", "Read"), tool("c", "Read"), tool("d", "Read")]));
    // 4 steps, window 3 → fold the first, keep the last 3.
    expect(liveVisibleStart(atoms, none, 3)).toBe(1);
  });

  it("keeps a still-running tool visible even beyond the window", () => {
    const atoms = flattenWork(
      segs([tool("a", "Read"), tool("b", "Read"), tool("c", "Read"), tool("d", "Read"), tool("e", "Read")]),
    );
    // 'a' is still running → everything from index 0 stays visible despite the 3-step window.
    const running = (id: string) => id === "a";
    expect(liveVisibleStart(atoms, running, 3)).toBe(0);
  });

  it("keeps a running sub-agent visible while settled steps before it fold", () => {
    const atoms = flattenWork(
      segs([
        tool("a", "Read"),
        tool("b", "Read"),
        tool("c", "Read"),
        tool("d", "Read"),
        tool("ag", "Agent"),
      ]),
    );
    const running = (id: string) => id === "ag";
    // step 'a' folds; b,c,d (the window) + the running sub-agent stay visible.
    expect(liveVisibleStart(atoms, running, 3)).toBe(1);
  });

  it("keeps everything visible when there are fewer than `window` steps", () => {
    const atoms = flattenWork(segs([tool("a", "Read"), tool("b", "Read")]));
    expect(liveVisibleStart(atoms, none, 3)).toBe(0);
  });
});

describe("atomStillRunning", () => {
  it("treats a missing tool_result as running when there is no task", () => {
    expect(atomStillRunning({ hasResult: false, taskStatus: null })).toBe(true);
    expect(atomStillRunning({ hasResult: true, taskStatus: null })).toBe(false);
  });

  it("lets the background task status win over the tool_result", () => {
    // The bug case: a sub-agent's Agent tool_result already arrived, but its terminal
    // task_notification hasn't — the task is still `running`, so it must stay visible.
    expect(atomStillRunning({ hasResult: true, taskStatus: "running" })).toBe(true);
    // Task reached a terminal status → done, foldable, even if the result map lags.
    expect(atomStillRunning({ hasResult: false, taskStatus: "completed" })).toBe(false);
    expect(atomStillRunning({ hasResult: false, taskStatus: "failed" })).toBe(false);
    expect(atomStillRunning({ hasResult: false, taskStatus: "stopped" })).toBe(false);
  });

  it("keeps a sub-agent visible while its task runs, then folds it once the task settles", () => {
    // [sub-agent, a, b, c, d] with window 3. windowStart alone would fold the sub-agent.
    const atoms = flattenWork(
      segs([
        tool("ag", "Agent"),
        tool("a", "Read"),
        tool("b", "Read"),
        tool("c", "Read"),
        tool("d", "Read"),
      ]),
    );
    // Every tool already has its result; the sub-agent's task is still `running` though, so it
    // stays pinned visible at index 0 despite the 3-step window that would otherwise fold it.
    const stillRunning = (id: string) =>
      atomStillRunning({ hasResult: true, taskStatus: id === "ag" ? "running" : null });
    expect(liveVisibleStart(atoms, stillRunning, 3)).toBe(0);
    // Once the task settles, the sub-agent is just ordinary work the window can fold: the
    // window keeps the last 3 steps (b, c, d) visible, folding the sub-agent and step a.
    const done = (id: string) =>
      atomStillRunning({ hasResult: true, taskStatus: id === "ag" ? "completed" : null });
    expect(liveVisibleStart(atoms, done, 3)).toBe(2);
  });
});

// ---- AskUserQuestion as a decision-artifact segment ------------------------
// A question to the user must anchor the exchange in the flow (own segment, breaks
// the run) and stay in clear when it closes a response — burying it as a "Question"
// step row inside a collapsed run made whole rounds unreadable (only tool rows shown).
describe("question segments", () => {
  it("AskUserQuestion becomes its own segment and breaks the surrounding run", () => {
    const segs = groupBlocks([
      tool("a", "Bash"),
      tool("q", "AskUserQuestion", { questions: [] }),
      tool("b", "Bash"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["run", "question", "run"]);
    if (segs[1].kind === "question") expect(segs[1].step.id).toBe("q");
  });

  it("splitFinalMessage peels a trailing question WITH its preceding prose", () => {
    const segs = groupBlocks([
      text("intro"),
      tool("a", "Bash"),
      text("explanation before the ask"),
      tool("q", "AskUserQuestion", { questions: [] }),
    ]);
    const { work, final } = splitFinalMessage(segs);
    expect(work.map((s) => s.kind)).toEqual(["text", "run"]);
    expect(final.map((s) => s.kind)).toEqual(["text", "question"]);
  });

  it("a question survives the atoms round-trip and never counts as work", () => {
    const segs = groupBlocks([
      tool("a", "Bash"),
      tool("q", "AskUserQuestion", { questions: [] }),
      tool("b", "Bash"),
    ]);
    const atoms = flattenWork(segs);
    expect(atoms.map((a) => a.kind)).toEqual(["step", "question", "step"]);
    const back = atomsToSegments(atoms, "k");
    expect(back.map((s) => s.kind)).toEqual(["run", "question", "run"]);
    expect(countWorkSteps(segs)).toBe(2); // the two Bash steps only
    expect(workStepIds(segs)).toEqual(["a", "b"]); // the question id is not "work"
  });
});
