import { describe, expect, it } from "vitest";
import type {
  TosseOffBoardTask,
  TosseProject,
  TosseTask,
  TosseTaskProject,
} from "../../ipc/client";
import type { TosseBriefing } from "../../ipc/client";
import {
  applyStatusToBoard,
  briefingTotals,
  groupByClient,
  groupOffBoardByProject,
  isOverdue,
  offBoardForScope,
  offBoardProjectCards,
  offBoardWithoutProject,
  OFF_BOARD_SECTIONS,
  projectActions,
  projectStatusTone,
  routeTaskStatus,
  sectionIcon,
  sectionLabel,
  shortDate,
  sortedBacklog,
  statusSections,
  STATUS_TONE,
  STATUSES_OFF_THE_BOARD,
  taskQuickAction,
  TASK_STATUS_CHOICES,
  type BoardCaches,
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

function taskProject(id: string, clientId: string | null = null): TosseTaskProject {
  return {
    id,
    name: id,
    status: "En cours",
    client: clientId
      ? { id: clientId, name: clientId.toUpperCase(), logoUrl: null, website: null }
      : null,
  };
}

/** One row of an off-board response. `projectId` null = a task attached to no project. */
function row(
  id: string,
  status: string,
  projectId: string | null,
  clientId: string | null = null,
): TosseOffBoardTask {
  return {
    project: projectId ? taskProject(projectId, clientId) : null,
    task: task(id, status),
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

describe("taskQuickAction", () => {
  it("closes a reviewed task in one click", () => {
    expect(taskQuickAction("Review")).toEqual({ label: "Done", next: "Fait", tone: "done" });
  });

  // The scope is the point of the feature, not an oversight: a button on every row would
  // put three one-click writes to the CRM where the list previously had none, and starting
  // a task already has its own gesture (the Start button, which goes through /pickup).
  // Every one of these statuses stays reachable through the row's dot menu.
  it("offers nothing on any other status", () => {
    for (const status of ["À faire", "En cours", "En attente", "Backlog", "Fait"]) {
      expect(taskQuickAction(status)).toBeNull();
    }
    // An unknown status from a CRM that gained one must fall through, not throw.
    expect(taskQuickAction("Something new")).toBeNull();
  });

  // The button writes a status the dot menu also offers; if the two ever disagreed, one of
  // them would be writing a value the CRM does not have.
  it("writes a status the menu itself offers", () => {
    const quick = taskQuickAction("Review");
    expect(TASK_STATUS_CHOICES).toContain(quick?.next);
  });

  // `Fait` is off the board, so the row must LEAVE the list rather than reappear under a
  // "Fait" heading that the briefing never sends.
  it("moves the task off the board", () => {
    expect(STATUSES_OFF_THE_BOARD).toContain(taskQuickAction("Review")?.next);
  });
});

describe("dates", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const DAY_MS = 86_400_000;

  /** The `yyyy-mm-dd` the VIEWER's clock is on at `t`. Derived rather than hard-coded so the
   *  assertions below hold on a machine in any timezone, not only the one that wrote them. */
  function viewerDay(t: number): string {
    const d = new Date(t);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Run `fn` with the process in `tz`, restoring the ambient zone afterwards.
   *
   *  ⚠️ The runner's own zone decides whether this bug is even REACHABLE: at a non-negative
   *  UTC offset, a UTC-midnight value read back with the local getters lands on the same
   *  calendar day, so the buggy code was accidentally right and a green suite in UTC (what
   *  CI runs — vitest.config.ts pins no TZ) would prove nothing. Assertions that need a
   *  negative offset to discriminate pin one here rather than trusting the machine. */
  function inZone<T>(tz: string, fn: () => T): T {
    // Reached through `globalThis` (the repo has no @types/node): assigning `process.env.TZ`
    // is what actually moves `Date`'s zone at runtime under the vitest runner.
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
      ?.env;
    if (!env) return fn(); // no process to pin (non-node runner) — run in the ambient zone
    const prev = env.TZ;
    env.TZ = tz;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete env.TZ;
      else env.TZ = prev;
    }
  }

  it("flags a past due date and only a past one", () => {
    expect(isOverdue("2026-07-28T00:00:00.000Z", now)).toBe(true);
    expect(isOverdue("2026-08-15T00:00:00.000Z", now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });

  // A CRM due date is a calendar DAY stamped at UTC midnight, so comparing it as an instant
  // called a task late from the first minute of the very day it was due — and, west of
  // Greenwich, from the evening before.
  it("does not flag a task due on the day the viewer is living in", () => {
    expect(isOverdue(`${viewerDay(now)}T00:00:00.000Z`, now)).toBe(false);
    // `now` must sit EARLY in the UTC day for this to discriminate everywhere: at 12:00Z a
    // viewer at UTC+12 or beyond is already on the next calendar day, whose UTC midnight is
    // still in the future — so the old instant compare answered `false` too and the
    // assertion passed against the very bug it exists to catch.
    const earlyNow = Date.parse("2026-08-03T01:00:00.000Z");
    expect(isOverdue(`${viewerDay(earlyNow)}T00:00:00.000Z`, earlyNow)).toBe(false);
  });

  it("flags a task once its day has passed for the viewer", () => {
    expect(isOverdue(`${viewerDay(now - DAY_MS)}T00:00:00.000Z`, now)).toBe(true);
  });

  it("renders nothing rather than NaN for an unparseable date", () => {
    expect(shortDate("not a date")).toBeNull();
    expect(shortDate(null)).toBeNull();
  });

  it("renders dd/mm, zero-padded", () => {
    expect(shortDate("2026-03-07T00:00:00.000Z")).toBe("07/03");
  });

  // The regression: the local-zone getters read a UTC-midnight day one day early anywhere
  // west of Greenwich (that value is 2026-03-06 19:00 in New York), so a deadline silently
  // rendered as the day before — indistinguishable from a correct one.
  //
  // ⚠️ Only a NEGATIVE offset discriminates: east of Greenwich (and in UTC itself) the old
  // getters happened to read the right day, so the ambient run is a guard, not the proof.
  // The pinned run is the one that goes red against the buggy code in CI.
  it("renders the calendar day the CRM minted, whatever the viewer's timezone", () => {
    const days = ["2026-01-01", "2026-03-07", "2026-06-30", "2026-12-31"];
    const check = () => {
      for (const day of days) {
        const [, month, date] = day.split("-");
        expect(shortDate(`${day}T00:00:00.000Z`), day).toBe(`${date}/${month}`);
        // The bare date-only form the CRM could equally send: ES parses it as UTC too.
        expect(shortDate(day), day).toBe(`${date}/${month}`);
      }
    };
    check(); // whatever zone the machine running the suite happens to be in
    inZone("America/New_York", check); // and one where the bug is actually reachable
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

describe("off-board grouping", () => {
  it("files each parked task under its project", () => {
    const rows = [row("b1", "Backlog", "p1"), row("b2", "Backlog", "p2"), row("b3", "Backlog", "p1")];
    const by = groupOffBoardByProject(rows);
    expect(by.p1.map((t) => t.id)).toEqual(["b1", "b3"]);
    expect(by.p2.map((t) => t.id)).toEqual(["b2"]);
  });

  // Project-less off-board tasks belong to the "No project" band, which reads them from the
  // raw list — grouping them under a project id would file them nowhere and lose them.
  it("leaves project-less tasks out rather than inventing a bucket", () => {
    const rows = [row("b-solo", "Backlog", null)];
    expect(groupOffBoardByProject(rows)).toEqual({});
    expect(offBoardWithoutProject(rows).map((t) => t.id)).toEqual(["b-solo"]);
  });

  it("is empty, not undefined, for a project with nothing parked", () => {
    expect(groupOffBoardByProject([])).toEqual({});
  });

  it("hands a card only the statuses it actually has rows for", () => {
    const byStatus = {
      "En attente": groupOffBoardByProject([row("w1", "En attente", "p1")]),
      Backlog: groupOffBoardByProject([row("b1", "Backlog", "p2")]),
    };
    expect(Object.keys(offBoardForScope(byStatus, "p1"))).toEqual(["En attente"]);
    expect(Object.keys(offBoardForScope(byStatus, "p2"))).toEqual(["Backlog"]);
    expect(offBoardForScope(byStatus, "p-none")).toEqual({});
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

describe("cards for projects the briefing omits", () => {
  const briefing = (): TosseBriefing => ({
    projects: [project("p1", "c1", [task("t1", "En cours")])],
    pausedProjects: [project("p-paused", "c1", [], { status: "En pause" })],
    generalTasks: [],
  });

  // The bug this exists for: a project whose whole queue is parked is absent from the
  // briefing, so its rows were fetched, grouped under an id no card had, and dropped.
  it("builds a card for a project that only has off-board work", () => {
    const cards = offBoardProjectCards(briefing(), [
      [row("w1", "En attente", "p-waiting", "c2")],
      [row("b1", "Backlog", "p-waiting", "c2")],
    ]);
    expect(cards.map((p) => p.id)).toEqual(["p-waiting"]);
    // Degraded by construction — the tasks endpoint sends no dates and no progress counts,
    // and the ring is hidden on a zero count rather than drawn as 0/0.
    expect(cards[0]).toMatchObject({ tasks: [], taskCount: 0, taskDone: 0, startDate: null });
    // The client comes through, so the card lands in the right band instead of "No client".
    expect(cards[0].client?.id).toBe("c2");
  });

  it("never duplicates a project the briefing already carries, paused ones included", () => {
    const cards = offBoardProjectCards(briefing(), [
      [row("b1", "Backlog", "p1"), row("b2", "Backlog", "p-paused")],
    ]);
    expect(cards).toEqual([]);
  });

  it("builds ONE card for a project with rows in several statuses", () => {
    const cards = offBoardProjectCards(briefing(), [
      [row("w1", "En attente", "p-new")],
      [row("b1", "Backlog", "p-new")],
    ]);
    expect(cards).toHaveLength(1);
  });

  // No briefing yet (first load, or a failed read) is not the same as "the briefing has no
  // such project": with nothing to compare against, every off-board project needs a card, or
  // its rows would be invisible for as long as the briefing takes.
  it("still builds cards when there is no briefing at all", () => {
    expect(offBoardProjectCards(null, [[row("b1", "Backlog", "p-x")]]).map((p) => p.id)).toEqual([
      "p-x",
    ]);
  });

  it("ignores project-less rows — they have their own band", () => {
    expect(offBoardProjectCards(briefing(), [[row("b1", "Backlog", null)]])).toEqual([]);
  });
});

describe("routing a status change across every cache", () => {
  const caches = (): BoardCaches => ({
    briefing: {
      projects: [project("p1", "c1", [task("t1", "À faire"), task("t2", "En cours")])],
      pausedProjects: [],
      generalTasks: [task("g1", "À faire")],
    },
    offBoard: {
      "En attente": [row("w1", "En attente", "p1")],
      Backlog: [row("b1", "Backlog", "p1")],
    },
  });

  // THE regression this function exists for: with only the briefing patched, sending a task
  // to « En attente » made it disappear — off the briefing, and not into the section right
  // below it where the user had just put it.
  it("moves a board task INTO the off-board section it was sent to", () => {
    const next = routeTaskStatus(caches(), "t1", "En attente");
    expect(next.briefing?.projects[0].tasks.map((t) => t.id)).toEqual(["t2"]);
    const waiting = next.offBoard["En attente"] ?? [];
    expect(waiting.map((r) => r.task.id)).toEqual(["w1", "t1"]);
    // It carries its project, so the card it lands on is the one it came from.
    expect(waiting[waiting.length - 1]?.project?.id).toBe("p1");
    expect(waiting[waiting.length - 1]?.task.status).toBe("En attente");
  });

  it("moves an off-board task back ONTO the board, under its project", () => {
    const next = routeTaskStatus(caches(), "w1", "En cours");
    expect(next.offBoard["En attente"]).toEqual([]);
    const tasks = next.briefing?.projects[0].tasks ?? [];
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2", "w1"]);
    expect(tasks.find((t) => t.id === "w1")?.status).toBe("En cours");
  });

  it("moves a task straight between two off-board sections", () => {
    const next = routeTaskStatus(caches(), "b1", "En attente");
    expect(next.offBoard.Backlog).toEqual([]);
    expect(next.offBoard["En attente"]?.map((r) => r.task.id)).toEqual(["w1", "b1"]);
  });

  // Pulling the last parked task of a briefing-less project onto the board would delete the
  // card it was standing on (nothing off-board left to build one from), so the row would be
  // nowhere at all until the refetch landed.
  it("fabricates the project entry when the briefing has never carried it", () => {
    const c = caches();
    c.offBoard["En attente"] = [row("w-x", "En attente", "p-ghost", "c9")];
    const next = routeTaskStatus(c, "w-x", "En cours");
    const built = next.briefing?.projects.find((p) => p.id === "p-ghost");
    expect(built?.tasks.map((t) => t.id)).toEqual(["w-x"]);
    expect(built?.client?.id).toBe("c9");
  });

  it("sends a project-less task back to the project-less band", () => {
    const c = caches();
    c.offBoard.Backlog = [row("b-solo", "Backlog", null)];
    const next = routeTaskStatus(c, "b-solo", "À faire");
    expect(next.briefing?.generalTasks.map((t) => t.id)).toEqual(["g1", "b-solo"]);
  });

  // `Fait` and `Archivé` have no list of their own here: closing a task means it leaves the
  // screen. Keeping it in some cache would make it come back on the next render.
  it("drops a task closed or archived, from wherever it was", () => {
    for (const status of ["Fait", "Archivé"]) {
      const fromBoard = routeTaskStatus(caches(), "t1", status);
      expect(fromBoard.briefing?.projects[0].tasks.map((t) => t.id), status).toEqual(["t2"]);
      const fromParked = routeTaskStatus(caches(), "b1", status);
      expect(fromParked.offBoard.Backlog, status).toEqual([]);
    }
  });

  // A list that was never fetched is `null`, and must STAY null: writing an empty array back
  // would tell the query cache the answer is "nothing", and the section would go silent
  // instead of loading.
  it("never turns an unfetched list into an empty one", () => {
    const c = caches();
    c.offBoard["En attente"] = null;
    const next = routeTaskStatus(c, "t1", "En attente");
    expect(next.offBoard["En attente"]).toBeNull();
    // The task still leaves the briefing — the server will not send it back there.
    expect(next.briefing?.projects[0].tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("works with no briefing cached at all", () => {
    const c = caches();
    c.briefing = null;
    const next = routeTaskStatus(c, "b1", "En attente");
    expect(next.briefing).toBeNull();
    expect(next.offBoard["En attente"]?.map((r) => r.task.id)).toEqual(["w1", "b1"]);
  });

  it("leaves everything alone when the id matches nothing", () => {
    const before = caches();
    const snapshot = JSON.stringify(before);
    const next = routeTaskStatus(before, "nope", "Fait");
    expect(JSON.stringify(next)).toBe(snapshot);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("does not mutate the caches it was given (the rollback snapshot must stay intact)", () => {
    const before = caches();
    const snapshot = JSON.stringify(before);
    routeTaskStatus(before, "t1", "En attente");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  // The sections the view fetches are exactly the ones the core will answer for
  // (`OFF_BOARD_STATUSES` in `src-tauri/src/tosse/mod.rs`). Asking for anything else surfaces
  // as an error about a request the user never made.
  it("fetches exactly the statuses the core allows, waiting work first", () => {
    expect([...OFF_BOARD_SECTIONS]).toEqual(["En attente", "Backlog"]);
    for (const status of OFF_BOARD_SECTIONS) {
      expect(STATUSES_OFF_THE_BOARD.has(status), status).toBe(true);
    }
  });
});

describe("status colours", () => {
  // The CRM's own badge (`status-badge.tsx`, dark variants) is the authority. The app used
  // to invert two of them — amber where the CRM is violet, violet where it is yellow — so a
  // task read in the browser and the same task read here were different colours.
  it("matches the CRM's badge, tone for tone", () => {
    expect(STATUS_TONE["En cours"]).toBe("run");
    expect(STATUS_TONE["Review"]).toBe("review");
    expect(STATUS_TONE["En attente"]).toBe("hold");
    expect(STATUS_TONE["Fait"]).toBe("done");
    expect(STATUS_TONE["Archivé"]).toBe("archived");
  });

  // They shared one tone, so the two statuses a card is most likely to show together were
  // indistinguishable.
  it("tells Backlog and « À faire » apart", () => {
    expect(STATUS_TONE["Backlog"]).not.toBe(STATUS_TONE["À faire"]);
  });

  // A project state is a different vocabulary painted with the same tokens: « En pause » is
  // the yellow of « En attente », « Terminé » the green of « Fait ».
  it("maps project states with their own table", () => {
    expect(projectStatusTone("En cours")).toBe("run");
    expect(projectStatusTone("En pause")).toBe("hold");
    expect(projectStatusTone("Terminé")).toBe("done");
    expect(projectStatusTone("Archivé")).toBe("archived");
    expect(projectStatusTone("À démarrer")).toBe("todo");
    // Unknown (« Annulé » today) and absent stay neutral rather than borrowing a meaning.
    expect(projectStatusTone("Annulé")).toBe("todo");
    expect(projectStatusTone(null)).toBe("todo");
  });
});
