import { describe, expect, it } from "vitest";
import type { TosseProject, TosseTask } from "../../ipc/client";
import {
  groupByClient,
  isOverdue,
  projectActions,
  shortDate,
  statusSections,
} from "./tosseModel";

function task(id: string, status: string, extra: Partial<TosseTask> = {}): TosseTask {
  return {
    id,
    title: id,
    status,
    priority: "Moyenne",
    kind: "Code",
    assignedTo: "Alexandre",
    dueDate: null,
    notes: null,
    subtaskCount: 0,
    subtaskDone: 0,
    ...extra,
  };
}

function project(
  id: string,
  clientId: string | null,
  tasks: TosseTask[],
  extra: Partial<TosseProject> = {},
): TosseProject {
  return {
    id,
    name: id,
    status: "En cours",
    client: clientId ? { id: clientId, name: clientId.toUpperCase(), logoUrl: null } : null,
    startDate: null,
    dueDate: null,
    tasks,
    taskCount: tasks.length,
    taskDone: 0,
    ...extra,
  };
}

describe("statusSections", () => {
  it("orders sections running-first, as the CRM briefing does", () => {
    const sections = statusSections([
      task("a", "À faire"),
      task("b", "Review"),
      task("c", "En cours"),
    ]);
    expect(sections.map((s) => s.status)).toEqual(["En cours", "Review", "À faire"]);
  });

  it("drops empty sections instead of rendering a fixed skeleton", () => {
    const sections = statusSections([task("a", "Review")]);
    expect(sections).toHaveLength(1);
    expect(sections[0].status).toBe("Review");
  });

  it("keeps a status it doesn't know about rather than dropping the task", () => {
    // A task that exists must be visible SOMEWHERE — silently filtering it would show a
    // short list that looks complete.
    const sections = statusSections([task("a", "En cours"), task("weird", "Annulée")]);
    expect(sections.map((s) => s.status)).toEqual(["En cours", "Annulée"]);
  });

  it("sorts a section by priority, then title, so equal rows never shuffle", () => {
    const sections = statusSections([
      task("z-mid", "À faire", { priority: "Moyenne", title: "z" }),
      task("low", "À faire", { priority: "Basse", title: "b" }),
      task("urgent", "À faire", { priority: "Urgente", title: "u" }),
      task("a-mid", "À faire", { priority: "Moyenne", title: "a" }),
    ]);
    expect(sections[0].tasks.map((t) => t.title)).toEqual(["u", "a", "z", "b"]);
  });

  it("treats an absent priority as ordinary, not as urgent or last", () => {
    const sections = statusSections([
      task("none", "À faire", { priority: null, title: "none" }),
      task("low", "À faire", { priority: "Basse", title: "low" }),
      task("high", "À faire", { priority: "Haute", title: "high" }),
    ]);
    expect(sections[0].tasks.map((t) => t.title)).toEqual(["high", "none", "low"]);
  });
});

describe("groupByClient", () => {
  it("groups projects under their client, in order of first appearance", () => {
    const bands = groupByClient([
      project("p1", "interne", [task("a", "En cours")]),
      project("p2", "webdent", [task("b", "Review")]),
      project("p3", "interne", [task("c", "À faire")]),
    ]);
    expect(bands.map((b) => b.key)).toEqual(["interne", "webdent"]);
    expect(bands[0].projects.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("gives project-less-client projects a trailing band instead of dropping them", () => {
    const bands = groupByClient([
      project("orphan", null, [task("a", "En cours")]),
      project("p1", "interne", [task("b", "En cours")]),
    ]);
    // "No client" is last even though its project came first.
    expect(bands.map((b) => b.key)).toEqual(["interne", "none"]);
    expect(bands[1].name).toBe("No client");
  });

  it("appends paused projects to their client's band", () => {
    const bands = groupByClient(
      [project("live", "interne", [task("a", "En cours")])],
      [project("parked", "interne", [], { status: "En pause" })],
    );
    expect(bands).toHaveLength(1);
    expect(bands[0].projects.map((p) => p.id)).toEqual(["live", "parked"]);
  });

  it("counts per status so a FOLDED band still reports what is inside", () => {
    const bands = groupByClient([
      project("p1", "interne", [task("a", "En cours"), task("b", "Review")]),
      project("p2", "interne", [task("c", "Review")]),
    ]);
    expect(bands[0].counts).toEqual({ "En cours": 1, Review: 2 });
    expect(bands[0].openTasks).toBe(3);
  });
});

describe("projectActions", () => {
  it("offers pause and a CONFIRMED finish while running", () => {
    const actions = projectActions("En cours");
    expect(actions.map((a) => a.next)).toEqual(["En pause", "Terminé"]);
    // Finishing closes a project — heavier than parking one, so it asks first.
    expect(actions[0].confirm).toBeUndefined();
    expect(actions[1].confirm).toBe(true);
  });

  it("offers a single move out of a paused or not-started project", () => {
    expect(projectActions("En pause").map((a) => a.next)).toEqual(["En cours"]);
    expect(projectActions("À démarrer").map((a) => a.next)).toEqual(["En cours"]);
  });

  it("offers nothing on a closed project — reopening is a CRM decision", () => {
    expect(projectActions("Terminé")).toEqual([]);
    expect(projectActions("Archivé")).toEqual([]);
    expect(projectActions(null)).toEqual([]);
  });
});

describe("dates", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");

  it("flags a past due date and only a past one", () => {
    expect(isOverdue("2026-07-28T00:00:00.000Z", now)).toBe(true);
    expect(isOverdue("2026-08-15T00:00:00.000Z", now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });

  it("renders nothing rather than NaN for an unparseable date", () => {
    expect(shortDate("not a date")).toBeNull();
    expect(shortDate(null)).toBeNull();
  });

  it("renders dd/mm, zero-padded", () => {
    expect(shortDate("2026-03-07T00:00:00.000Z")).toBe("07/03");
  });
});
