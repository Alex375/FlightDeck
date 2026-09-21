import { describe, expect, it } from "vitest";
import {
  isTosseMcpTool,
  isTosseWriteTool,
  parseTosseTaskResult,
  parseTosseTool,
  priorTaskStatus,
  tosseAction,
  tosseCardView,
  tosseReadCount,
  taskStatusSightings,
  tosseStepLabel,
} from "./tosseTool";

/** A task payload in the shape the CRM actually returns (trimmed from a real update_task_status). */
const TASK = JSON.stringify({
  id: "6edf5907-048b-4b61-a6fc-b85bc14253c9",
  title: "Style the TOSSE MCP calls",
  projectId: "ef02be22",
  type: "Code",
  status: "En cours",
  priority: "Moyenne",
  assignedTo: "Alexandre",
  project: { id: "ef02be22", name: "Tosse Code" },
});

describe("recognising the CRM's server", () => {
  it("accepts every segment the same CRM reaches us under", () => {
    // The claude.ai connector, a plugin variant, and the Codex-side name — all one CRM.
    expect(parseTosseTool("mcp__claude_ai_TOSSE__create_task")).toBe("create_task");
    expect(parseTosseTool("mcp__tosse__create_task")).toBe("create_task");
    expect(parseTosseTool("mcp__tosse_workflow__get_tasks")).toBe("get_tasks");
  });

  it("is case-insensitive on the server segment", () => {
    expect(isTosseMcpTool("mcp__Tosse_Crm__update_task")).toBe(true);
  });

  it("claims nothing from another server, whatever the tool is called", () => {
    expect(parseTosseTool("mcp__playwright__create_task")).toBeNull();
    expect(parseTosseTool("mcp__flightdeck__send_message")).toBeNull();
    expect(parseTosseTool("Read")).toBeNull();
  });

  it("leaves an unplaceable tool on a tosse-ish server to the ordinary MCP path", () => {
    // Recognising the server is not enough: without a verb we can place, the call stays a
    // plain step rather than being dressed as a CRM action.
    expect(parseTosseTool("mcp__tosse__ping")).toBeNull();
    expect(isTosseMcpTool("mcp__tosse__ping")).toBe(false);
  });
});

describe("classifying an action", () => {
  it("routes writes and reads to their shapes", () => {
    expect(isTosseWriteTool("mcp__claude_ai_TOSSE__create_task")).toBe(true);
    expect(isTosseWriteTool("mcp__claude_ai_TOSSE__update_task_status")).toBe(true);
    expect(isTosseWriteTool("mcp__claude_ai_TOSSE__update_context")).toBe(true);
    expect(isTosseWriteTool("mcp__claude_ai_TOSSE__create_client")).toBe(true);
    // A read is intermediate work: it never gets a card.
    expect(isTosseWriteTool("mcp__claude_ai_TOSSE__get_tasks")).toBe(false);
    expect(isTosseWriteTool("mcp__claude_ai_TOSSE__list_subtasks")).toBe(false);
  });

  it("puts each write in its family", () => {
    expect(tosseAction("create_subtask").family).toBe("task");
    expect(tosseAction("add_task_relation").family).toBe("task");
    expect(tosseAction("sync_claude_md").family).toBe("context");
    expect(tosseAction("update_context").family).toBe("context");
    expect(tosseAction("archive_mission").family).toBe("entity");
  });

  it("places a tool the catalogue has never seen, by its verb", () => {
    // The CRM ships tools before we do; a new one must still land in a sane shape rather
    // than falling back to the anonymous plug.
    expect(tosseAction("archive_invoice")).toMatchObject({ family: "entity", verb: "archived", entity: "invoice" });
    expect(tosseAction("list_invoices").family).toBe("read");
    expect(isTosseWriteTool("mcp__tosse__archive_invoice")).toBe(true);
  });
});

describe("step labels", () => {
  it("names what a lookup looked up", () => {
    expect(tosseStepLabel("mcp__claude_ai_TOSSE__get_tasks")).toBe("Read tasks");
    expect(tosseStepLabel("mcp__claude_ai_TOSSE__get_context_chain")).toBe("Read the context chain");
  });

  it("names an unknown CRM tool plainly rather than by its wire name", () => {
    expect(tosseStepLabel("mcp__tosse__update_invoice")).toBe("TOSSE · update invoice");
  });

  it("returns null for anything that isn't a CRM call", () => {
    expect(tosseStepLabel("mcp__playwright__browser_click")).toBeNull();
  });
});

describe("read counts", () => {
  it("counts the rows a list came back with", () => {
    expect(tosseReadCount("mcp__claude_ai_TOSSE__get_tasks", "[{},{},{}]")).toBe("3 tasks");
    expect(tosseReadCount("mcp__claude_ai_TOSSE__list_subtasks", "[]")).toBe("0 subtasks");
    expect(tosseReadCount("mcp__claude_ai_TOSSE__get_tasks", "[{}]")).toBe("1 task");
  });

  it("says nothing rather than something wrong", () => {
    // A single object is one thing, not a count; a truncation notice is not JSON at all;
    // a read with no plural noun (the briefing, a balance) has nothing to count.
    expect(tosseReadCount("mcp__claude_ai_TOSSE__get_tasks", "{}")).toBeNull();
    expect(tosseReadCount("mcp__claude_ai_TOSSE__get_tasks", "Error: result too large")).toBeNull();
    expect(tosseReadCount("mcp__claude_ai_TOSSE__get_daily_briefing", "[{},{}]")).toBeNull();
    expect(tosseReadCount("mcp__claude_ai_TOSSE__create_task", "[{},{}]")).toBeNull();
  });
});

describe("parsing a task result", () => {
  it("reads the fields the card shows", () => {
    expect(parseTosseTaskResult(TASK)).toEqual({
      id: "6edf5907-048b-4b61-a6fc-b85bc14253c9",
      title: "Style the TOSSE MCP calls",
      status: "En cours",
      priority: "Moyenne",
      type: "Code",
      assignedTo: "Alexandre",
      project: "Tosse Code",
    });
  });

  it("keeps whatever survived a drifted payload", () => {
    // A field the CRM renamed or dropped must cost only itself, never the whole card.
    expect(parseTosseTaskResult('{"id":"x","title":"T"}')).toMatchObject({
      title: "T",
      status: null,
      project: null,
    });
    // A non-string where a string was expected is dropped, not coerced.
    expect(parseTosseTaskResult('{"title":"T","status":42}')?.status).toBeNull();
  });

  it("refuses to dress a non-task payload as a task", () => {
    expect(parseTosseTaskResult('{"ok":true}')).toBeNull();
    expect(parseTosseTaskResult("[]")).toBeNull();
    expect(parseTosseTaskResult("not json at all")).toBeNull();
    expect(parseTosseTaskResult(undefined)).toBeNull();
  });
});

describe("the card view", () => {
  it("heads a created task with its title and names the project it landed in", () => {
    const v = tosseCardView("mcp__claude_ai_TOSSE__create_task", { title: "ignored" }, TASK);
    expect(v.family).toBe("task");
    expect(v.headline).toBe("Style the TOSSE MCP calls");
    expect(v.detail).toBe("Tosse Code");
    expect(v.taskId).toBe("6edf5907-048b-4b61-a6fc-b85bc14253c9");
    expect(v.action.verb).toBe("created");
  });

  it("carries the landing status as a pill, never as eyebrow text", () => {
    const v = tosseCardView(
      "mcp__claude_ai_TOSSE__update_task_status",
      { task_id: "6edf5907", status: "Review" },
      TASK,
    );
    expect(v.statusTo).toBe("En cours"); // the CRM's answer wins over the request
    expect(v.detail).toBeNull(); // …and the eyebrow does not repeat it
  });

  it("stands in with the REQUESTED status while the CRM has not answered", () => {
    // A move in flight already reads as the move it is, rather than as a blank card.
    const v = tosseCardView(
      "mcp__claude_ai_TOSSE__update_task_status",
      { task_id: "6edf5907", status: "Review" },
      undefined,
    );
    expect(v.task).toBeNull();
    expect(v.statusTo).toBe("Review");
  });

  it("names the exact tool that ran", () => {
    // The CRM exposes ~60 tools; "TOSSE task · moved" does not identify the call.
    expect(tosseCardView("mcp__claude_ai_TOSSE__update_task_status", {}, TASK).tool).toBe(
      "update_task_status",
    );
    expect(tosseCardView("mcp__tosse__sync_claude_md", {}, undefined).tool).toBe("sync_claude_md");
  });

  it("names the fields a partial update touched, never the identifiers", () => {
    const v = tosseCardView(
      "mcp__claude_ai_TOSSE__update_task",
      { task_id: "6edf5907", priority: "Haute", due_date: "2026-10-01" },
      TASK,
    );
    expect(v.detail).toBe("priority, due date");
  });

  it("falls back to the input when the result carries no task", () => {
    // A write whose ack is a bare "ok" still has to say WHICH task it was about.
    const v = tosseCardView(
      "mcp__claude_ai_TOSSE__create_task",
      { title: "Filed from the input" },
      '{"ok":true}',
    );
    expect(v.headline).toBe("Filed from the input");
    expect(v.task).toBeNull();
  });

  it("carries the context level on a context write", () => {
    const v = tosseCardView(
      "mcp__claude_ai_TOSSE__update_context",
      { entity_type: "project", entity_id: "ef02be22", context: "…" },
      '{"ok":true}',
    );
    expect(v.family).toBe("context");
    expect(v.detail).toBe("project");
    expect(v.headline).toBe("project context");
  });

  it("never empties, whatever the payload", () => {
    // The worst case — nothing parseable on either side — must still produce a headline.
    const v = tosseCardView("mcp__tosse__archive_invoice", null, undefined);
    expect(v.headline).toBe("Archive invoice");
    expect(v.action.verb).toBe("archived");
  });

  it("heads an unnamed call with the ACTION, never with an outcome it cannot claim", () => {

    // A failed archive has no payload to name the task from. "Task archived" would assert
    // exactly the thing that did not happen, so the headline states the attempt instead.
    const failed = tosseCardView("mcp__claude_ai_TOSSE__archive_task", { task_id: "x" }, undefined);
    expect(failed.headline).toBe("Archive task");
    // …and it still knows WHICH task, so the card can link to it.
    expect(failed.taskId).toBe("x");
  });
});

describe("where the task was before", () => {
  it("finds a task's status anywhere in a payload", () => {
    expect(taskStatusSightings(JSON.parse(TASK))).toContainEqual([
      "6edf5907-048b-4b61-a6fc-b85bc14253c9",
      "En cours",
    ]);
    // A list of tasks, and the subtasks nested inside one.
    expect(taskStatusSightings([{ id: "a", status: "À faire" }, { id: "b", status: "Review" }])).toEqual([
      ["a", "À faire"],
      ["b", "Review"],
    ]);
    expect(
      taskStatusSightings({ id: "p", status: "En cours", subtasks: [{ id: "s", status: "Fait" }] }),
    ).toEqual([
      ["p", "En cours"],
      ["s", "Fait"],
    ]);
  });

  it("yields nothing for a shape that carries no status", () => {
    expect(taskStatusSightings({ context: "…", name: "Tosse Code" })).toEqual([]);
    expect(taskStatusSightings(null)).toEqual([]);
    expect(taskStatusSightings("not an object" as never)).toEqual([]);
  });

  // A minimal SessionEntry: one assistant turn whose blocks are the TOSSE calls, with their
  // results joined by id — the shape the conversation store holds.
  const entryOf = (
    blocks: Array<{ id: string; name: string }>,
    results: Record<string, { content: string; isError?: boolean }>,
  ) =>
    ({
      timeline: [{ kind: "turn", id: "t1" }],
      turns: {
        t1: {
          role: "assistant",
          parentToolUseId: null,
          blocks: blocks.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: {} })),
        },
      },
      toolResults: Object.fromEntries(
        Object.entries(results).map(([id, r]) => [
          id,
          { toolUseId: id, content: r.content, isError: r.isError ?? false, parentToolUseId: null },
        ]),
      ),
    }) as never;

  const T = "task-1";
  const tosse = (t: string) => `mcp__claude_ai_TOSSE__${t}`;

  it("reads the status a lookup saw before the move", () => {
    const entry = entryOf(
      [
        { id: "r", name: tosse("get_tasks") },
        { id: "w", name: tosse("update_task_status") },
      ],
      { r: { content: JSON.stringify([{ id: T, status: "À faire" }]) } },
    );
    expect(priorTaskStatus(entry, "w", T)).toBe("À faire");
  });

  it("never reads the call's OWN result as the status it came from", () => {
    // The whole trap: the CRM answers a move with the task AFTER it. Counting that sighting
    // would render "En cours → En cours" — a transition that never happened.
    const entry = entryOf([{ id: "w", name: tosse("update_task_status") }], {
      w: { content: JSON.stringify({ id: T, status: "En cours" }) },
    });
    expect(priorTaskStatus(entry, "w", T)).toBeNull();
  });

  it("takes the LAST sighting before the call, across several", () => {
    const entry = entryOf(
      [
        { id: "r1", name: tosse("get_tasks") },
        { id: "w1", name: tosse("update_task_status") },
        { id: "w2", name: tosse("update_task_status") },
      ],
      {
        r1: { content: JSON.stringify([{ id: T, status: "Backlog" }]) },
        w1: { content: JSON.stringify({ id: T, status: "À faire" }) },
      },
    );
    // w2 moved the task away from where w1 left it, not from where the first lookup saw it.
    expect(priorTaskStatus(entry, "w2", T)).toBe("À faire");
  });

  it("does not parse a payload that cannot contain the task", () => {
    // The selector re-runs on every streamed token, and a CRM lookup can be 200 kB. A result
    // that does not even mention the id must be discarded before JSON ever sees it — this
    // asserts the behaviour that proves it: unparseable junk that lacks the id is skipped
    // rather than throwing or costing a parse.
    const entry = entryOf(
      [
        { id: "big", name: tosse("list_projects") },
        { id: "r", name: tosse("get_tasks") },
        { id: "w", name: tosse("update_task_status") },
      ],
      {
        big: { content: `{ not valid json at all, ${"x".repeat(5000)}` },
        r: { content: JSON.stringify([{ id: T, status: "Review" }]) },
      },
    );
    expect(priorTaskStatus(entry, "w", T)).toBe("Review");
  });

  it("claims nothing it cannot know", () => {
    const seen = entryOf([{ id: "w", name: tosse("update_task_status") }], {});
    expect(priorTaskStatus(seen, "w", T)).toBeNull(); // never sighted
    expect(priorTaskStatus(seen, "w", null)).toBeNull(); // no task to track
    expect(priorTaskStatus(undefined, "w", T)).toBeNull(); // no conversation
    // A call this thread does not contain (a sub-agent's card): no ordering we can trust.
    expect(priorTaskStatus(seen, "elsewhere", T)).toBeNull();
    // A FAILED lookup is not a sighting — its result is an error message, not a task.
    const failed = entryOf(
      [
        { id: "r", name: tosse("get_tasks") },
        { id: "w", name: tosse("update_task_status") },
      ],
      { r: { content: JSON.stringify([{ id: T, status: "À faire" }]), isError: true } },
    );
    expect(priorTaskStatus(failed, "w", T)).toBeNull();
  });
});
