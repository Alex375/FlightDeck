// Who the app goes and asks about, one task at a time.
//
// The bug this exists for: a task that moves to « Fait » leaves the briefing for ever, and
// an absent task is deliberately left alone — so the conversation kept « Review » and the
// delete dialog kept asking. Both halves of the rule are locked here: the contradiction IS
// reconciled, and everything else stays free.

import { describe, expect, it } from "vitest";
import type { TosseBriefing, TosseProject, TosseTask } from "../../ipc/client";
import { briefingTaskIds, tasksToReconcile } from "./linkedTaskReconcile";

function task(id: string, status = "En cours"): TosseTask {
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
  };
}

function project(id: string, tasks: TosseTask[]): TosseProject {
  return {
    id,
    name: id,
    status: "En cours",
    client: null,
    startDate: null,
    dueDate: null,
    tasks,
    taskCount: tasks.length,
    taskDone: 0,
  };
}

function briefing(extra: Partial<TosseBriefing> = {}): TosseBriefing {
  return { projects: [], pausedProjects: [], generalTasks: [], ...extra };
}

describe("briefingTaskIds", () => {
  it("collects the project tasks AND the project-less ones", () => {
    const ids = briefingTaskIds(
      briefing({
        projects: [project("p1", [task("t-1"), task("t-2")])],
        generalTasks: [task("t-3")],
      }),
    );
    expect(ids).toEqual(new Set(["t-1", "t-2", "t-3"]));
  });

  // ⚠️ The same distinction `resolve_links` makes on the Rust side: not having looked is
  // not a verdict. Without it, the very first render — before the briefing lands — would
  // fire one request per linked conversation.
  it("answers null when there is no briefing yet, never an empty set", () => {
    expect(briefingTaskIds(undefined)).toBeNull();
    expect(briefingTaskIds(briefing())).toEqual(new Set());
  });
});

describe("tasksToReconcile", () => {
  it("asks about a task we believe is live that the board did not list", () => {
    // The reported bug, exactly: the CRM has nothing in Review, the conversation still says
    // Review, so the delete dialog fires for work that is done.
    expect(
      tasksToReconcile([{ taskId: "t-1", status: "Review" }], new Set()),
    ).toEqual(["t-1"]);
    expect(
      tasksToReconcile([{ taskId: "t-1", status: "En cours" }], new Set()),
    ).toEqual(["t-1"]);
  });

  it("asks nothing about a task the briefing already re-stamped", () => {
    expect(
      tasksToReconcile([{ taskId: "t-1", status: "En cours" }], new Set(["t-1"])),
    ).toEqual([]);
  });

  // Only the statuses that make the dialog appear are worth a request. This is also what
  // makes the set self-limiting: the answer that says « Fait » drops the id for good.
  it("leaves alone a status the delete warning does not act on", () => {
    for (const status of ["À faire", "Backlog", "En attente", "Fait", "Archivé", null]) {
      expect(tasksToReconcile([{ taskId: "t-1", status }], new Set())).toEqual([]);
    }
  });

  it("holds off entirely until the briefing has answered", () => {
    expect(tasksToReconcile([{ taskId: "t-1", status: "Review" }], null)).toEqual([]);
  });

  it("asks once for a task several conversations share", () => {
    expect(
      tasksToReconcile(
        [
          { taskId: "t-1", status: "Review" },
          { taskId: "t-1", status: "En cours" },
          { taskId: "t-2", status: "En cours" },
        ],
        new Set(),
      ),
    ).toEqual(["t-1", "t-2"]);
  });
});
