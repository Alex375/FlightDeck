import { describe, expect, it } from "vitest";
import type { TosseProject, TosseTask } from "../../ipc/client";
import type { TosseBriefing } from "../../ipc/client";
import {
  applyStatusToBoard,
  briefingTotals,
  groupBacklogByProject,
  groupByClient,
  isOverdue,
  projectActions,
  sectionIcon,
  sectionLabel,
  shortDate,
  sortedBacklog,
  statusSections,
  STATUSES_OFF_THE_BOARD,
  TASK_STATUS_CHOICES,
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
    client: clientId
      ? { id: clientId, name: clientId.toUpperCase(), logoUrl: null, website: null }
      : null,
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

describe("toolbar totals", () => {
  // The regression these lock down: the header counted `projects[].tasks` only, so the
  // project-less band — a band the page RENDERS, right below — was missing from the totals.
  // The bar read "5 À faire" above six visible rows, with nothing to explain the gap.
  it("counts the project-less band, not just the projects", () => {
    const projects = [project("p1", "c1", [task("t1", "À faire"), task("t2", "En cours")])];
    const general = [task("g1", "À faire"), task("g2", "Review")];

    expect(briefingTotals(projects, general)).toEqual({
      "À faire": 2,
      "En cours": 1,
      Review: 1,
    });
  });

  it("still adds up with no project-less tasks at all", () => {
    const projects = [project("p1", "c1", [task("t1", "Review"), task("t2", "Review")])];
    expect(briefingTotals(projects)).toEqual({ Review: 2 });
    expect(briefingTotals(projects, [])).toEqual({ Review: 2 });
  });

  it("is empty rather than undefined when there is nothing open", () => {
    expect(briefingTotals([], [])).toEqual({});
  });
});

describe("section headings", () => {
  // The CRM's Briefing titles the Review column « En revue » while the status VALUE stays
  // « Review » — the two must not be conflated, or a status write would send a name the
  // server does not know.
  it("renames only Review, and only as a heading", () => {
    expect(sectionLabel("Review")).toBe("En revue");
    expect(sectionLabel("En cours")).toBe("En cours");
    expect(sectionLabel("À faire")).toBe("À faire");
    // The value written to the CRM is untouched.
    expect(TASK_STATUS_CHOICES).toContain("Review");
    expect(TASK_STATUS_CHOICES).not.toContain("En revue");
  });

  it("gives every status an icon, and never renders a bare heading", () => {
    expect(sectionIcon("En cours")).toBe("play");
    expect(sectionIcon("Review")).toBe("eye");
    expect(sectionIcon("En attente")).toBe("circledot");
    // An unknown status still gets a glyph rather than an empty slot.
    expect(sectionIcon("Statut inconnu")).toBe("list");
  });
});

describe("backlog grouping", () => {
  it("files each parked task under its project", () => {
    const rows = [
      { projectId: "p1", task: task("b1", "Backlog") },
      { projectId: "p2", task: task("b2", "Backlog") },
      { projectId: "p1", task: task("b3", "Backlog") },
    ];
    const by = groupBacklogByProject(rows);
    expect(by.p1.map((t) => t.id)).toEqual(["b1", "b3"]);
    expect(by.p2.map((t) => t.id)).toEqual(["b2"]);
  });

  // Project-less backlog tasks belong to the "No project" band, which reads them from the
  // raw list — grouping them under a project id would file them nowhere and lose them.
  it("leaves project-less tasks out rather than inventing a bucket", () => {
    const by = groupBacklogByProject([{ projectId: null, task: task("b-solo", "Backlog") }]);
    expect(by).toEqual({});
  });

  it("is empty, not undefined, for a project with nothing parked", () => {
    expect(groupBacklogByProject([])).toEqual({});
  });

  it("orders the backlog like every other section (priority, then title)", () => {
    const rows = [
      task("z", "Backlog", { priority: "Basse", title: "z" }),
      task("a", "Backlog", { priority: "Urgente", title: "a" }),
      task("m", "Backlog", { priority: "Moyenne", title: "m" }),
    ];
    expect(sortedBacklog(rows).map((t) => t.title)).toEqual(["a", "m", "z"]);
  });
});

describe("optimistic status patch", () => {
  const board = (): TosseBriefing => ({
    projects: [project("p1", "c1", [task("t1", "À faire"), task("t2", "En cours")])],
    pausedProjects: [],
    generalTasks: [task("g1", "À faire")],
  });

  it("moves a task inside a project", () => {
    const next = applyStatusToBoard(board(), "t1", "En cours");
    expect(next.projects[0].tasks.find((t) => t.id === "t1")?.status).toBe("En cours");
    // Its neighbours are untouched.
    expect(next.projects[0].tasks.find((t) => t.id === "t2")?.status).toBe("En cours");
  });

  // The regression: `generalTasks` was skipped, so a project-less row never moved. That is
  // what made a REFUSED write invisible — there was no optimistic change to roll back, so
  // failure looked exactly like success.
  it("moves a PROJECT-LESS task too", () => {
    const next = applyStatusToBoard(board(), "g1", "En cours");
    expect(next.generalTasks[0].status).toBe("En cours");
  });

  it("drops a project-less task that leaves the board", () => {
    expect(applyStatusToBoard(board(), "g1", "Fait").generalTasks).toEqual([]);
  });

  // The server's briefing filter excludes four statuses, not one. Keeping a row the next
  // refetch deletes makes it linger a second and then vanish on its own — a glitch, not the
  // move the user asked for.
  it("drops a task for EVERY status that leaves the briefing, not just « Fait »", () => {
    for (const status of ["Fait", "Backlog", "En attente", "Archivé"]) {
      const next = applyStatusToBoard(board(), "t1", status);
      expect(next.projects[0].tasks.map((t) => t.id), `status ${status}`).toEqual(["t2"]);
    }
  });

  it("keeps a task that stays on the board", () => {
    for (const status of ["À faire", "En cours", "Review"]) {
      const next = applyStatusToBoard(board(), "t1", status);
      expect(next.projects[0].tasks.map((t) => t.id), `status ${status}`).toEqual(["t1", "t2"]);
    }
  });

  it("mirrors the server's own exclusion list", () => {
    // briefing.service.ts: status: { notIn: ['Archivé', 'Fait', 'Backlog', 'En attente'] }
    expect([...STATUSES_OFF_THE_BOARD].sort()).toEqual(
      ["Archivé", "Backlog", "En attente", "Fait"].sort(),
    );
  });

  it("does not mutate the board it was given (the rollback copy must stay intact)", () => {
    const before = board();
    const snapshot = JSON.stringify(before);
    applyStatusToBoard(before, "t1", "Fait");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("leaves the board alone when the id matches nothing", () => {
    const next = applyStatusToBoard(board(), "nope", "Fait");
    expect(next.projects[0].tasks).toHaveLength(2);
    expect(next.generalTasks).toHaveLength(1);
  });
});
