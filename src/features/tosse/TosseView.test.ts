// The regression an adversarial review caught, locked down: a REFUSED status write on a
// task with no project must say so.
//
// Every row in the « No project » band used to create its own mutation, and nothing ever
// read the result. Combined with an optimistic patch that skipped `generalTasks` entirely,
// a rejected write produced NOTHING on screen — no move, no revert, no message — which is
// the exact same screen an accepted write produced. The user clicked, saw nothing, clicked
// again, and walked away believing the CRM had been updated.
//
// Renders through react-dom/client (NOT renderToStaticMarkup): the view reads zustand
// stores, whose SSR path would feed `useSyncExternalStore` the INITIAL state and never
// observe them. `*.test.ts` (the vitest glob), so elements are built with createElement —
// no JSX.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TosseBriefing, TosseOffBoardTask, TosseTask } from "../../ipc/client";

const REFUSAL = "Task is blocked by « Lot 1 » and cannot be started";

// What each hook hands back. `refuseWrites` makes the shared task mutation reject, through
// the SAME callback path the component uses, so the test exercises the real wiring rather
// than a pre-set error field.
const state = {
  briefing: undefined as TosseBriefing | undefined,
  offBoard: {} as Record<string, TosseOffBoardTask[]>,
  refuseWrites: false,
};

const mutation = () => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  error: null as Error | null,
});

/** The task-status mutation: calls back `onError` when the CRM is set to refuse. */
const taskStatusMutation = () => ({
  ...mutation(),
  mutate: (
    _vars: unknown,
    opts?: { onError?: (e: Error) => void; onSuccess?: () => void },
  ) => {
    if (state.refuseWrites) opts?.onError?.(new Error(REFUSAL));
    else opts?.onSuccess?.();
  },
});

vi.mock("../../ipc/useTosse", () => ({
  useTosseBriefing: () => ({
    data: state.briefing,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    dataUpdatedAt: 0,
  }),
  useTosseTaskDetail: () => ({ data: undefined, isLoading: false, error: null }),
  // Backlog and « En attente » each come from their own request, keyed by status.
  useTosseOffBoard: (status: string) => ({
    data: state.offBoard[status] ?? [],
    isLoading: false,
    error: null,
  }),
  useSetTosseTaskStatus: () => taskStatusMutation(),
  useSetTosseProjectStatus: () => mutation(),
  useCreateTosseTask: () => mutation(),
  useTosseWebUrl: () => ({ data: "https://tosse.example", error: null }),
  // Lot 3's launch path: these tests are about the board, so the folder resolution has
  // nothing to answer with — which is also the honest state before any pin is made.
  useTosseProjectRepos: () => ({ data: [] }),
  useTosseRepoLinks: () => ({ data: undefined }),
  useLinkTosseProjectRepo: () => mutation(),
}));

// The opener plugin has no Tauri host under vitest.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { TosseView } from "./TosseView";
import { useTosseFold } from "../../store/tosseFold";

function task(id: string, status: string, over: Partial<TosseTask> = {}): TosseTask {
  return {
    id,
    title: id,
    status,
    priority: "Moyenne",
    kind: "Admin",
    assignedTo: "Alexandre",
    dueDate: null,
    notes: null,
    subtaskCount: 0,
    subtaskDone: 0,
    ...over,
  };
}

/** A board whose ONLY open work is a project-less task — the band under test. */
function boardWithOnlyAGeneralTask(): TosseBriefing {
  return {
    projects: [],
    pausedProjects: [],
    generalTasks: [task("g-urssaf", "À faire", { title: "Déclarer l'URSSAF" })],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  state.briefing = boardWithOnlyAGeneralTask();
  state.offBoard = {};
  state.refuseWrites = false;
  // The fold store persists to localStorage, and it is shared by every test in this file:
  // a section left closed by one would silently make the next one's assertion about a
  // default meaningless.
  localStorage.clear();
  useTosseFold.setState({ folded: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render() {
  act(() => root.render(createElement(TosseView, { onOpenConversation: () => {} })));
}

/** Drive a real status change: click the row's status dot, then the menu entry.
 *
 *  Two separate `act`s — the menu only exists after the first click has been committed —
 *  and the entry is looked up on `document`, since the menu renders through a portal. */
function clickStatus(status: string) {
  // By title, not by class: CSS-module hashes make `[class*='dot_']` also match
  // `sectionDot`, and it picked the section heading's plain span instead of the control.
  const dot = container.querySelector<HTMLButtonElement>("button[title*='change status']");
  if (!dot) throw new Error("no status dot on the row");
  act(() => dot.click());
  const item = [...document.querySelectorAll<HTMLButtonElement>("button.wf-mi")].find(
    (el) => el.textContent?.trim() === status,
  );
  if (!item) throw new Error(`no menu entry for "${status}"`);
  act(() => item.click());
}

describe("the « No project » band", () => {
  it("renders its tasks", () => {
    render();
    expect(container.textContent).toContain("Déclarer l'URSSAF");
    expect(container.textContent).toContain("No project");
  });

  // The assertion this test was missing, and which let the bug through: the empty state was
  // gated on the CLIENT bands only, so a board whose only work is project-less printed
  // "Nothing open in TOSSE" directly above the tasks it was denying — while the toolbar,
  // which does count them, announced how many there were.
  it("does not claim the board is empty while it is listing tasks", () => {
    render();
    expect(container.textContent).not.toContain("Nothing open in TOSSE");
  });

  // ⚠️ THE regression. Driven through the real path: open the row's status menu, pick a
  // status, let the write be refused. Before the fix the band rendered no error at all;
  // before the SECOND fix the message lived on a mutation shared by every row, so the next
  // click on another row wiped it.
  it("shows why a status write was refused, under the row it happened on", () => {
    state.refuseWrites = true;
    render();
    clickStatus("En cours");
    expect(container.textContent).toContain(REFUSAL);
  });

  it("says nothing when no write has failed", () => {
    render();
    clickStatus("En cours");
    expect(container.textContent).not.toContain(REFUSAL);
  });
});

/** A project as a `/api/v1/tasks` row names it — less than the briefing's shape. */
function offBoardRow(id: string, title: string, status: string, projectId: string | null) {
  return {
    project: projectId
      ? {
          id: projectId,
          name: "Refonte site",
          status: "En cours",
          client: { id: "c-wd", name: "Webdentiste", logoUrl: null, website: null },
        }
      : null,
    task: task(id, status, { title }),
  };
}

describe("the off-board sections", () => {
  // The whole point of the feature: « En attente » was fetched by nobody and rendered
  // nowhere, so 17 waiting tasks existed only in the CRM's browser tab.
  it("shows waiting tasks, open without being asked", () => {
    state.briefing = {
      projects: [],
      pausedProjects: [],
      generalTasks: [task("g-urssaf", "À faire", { title: "Déclarer l'URSSAF" })],
    };
    state.offBoard = { "En attente": [offBoardRow("w1", "Retour du client", "En attente", null)] };
    render();
    expect(container.textContent).toContain("En attente");
    // OPEN by default (Alexandre, 2026-08-11) — waiting work is live work, so the rows are
    // there without a click. The backlog's opposite default is asserted right below.
    expect(container.textContent).toContain("Retour du client");
  });

  it("keeps the backlog closed by default, heading and all", () => {
    state.offBoard = { Backlog: [offBoardRow("b1", "Audit annuel", "Backlog", null)] };
    render();
    expect(container.textContent).toContain("Backlog");
    expect(container.textContent).not.toContain("Audit annuel");
  });

  // The gap that made this more than a rendering change: a project whose whole queue is
  // parked is ABSENT from the briefing, so its rows had no card to be drawn on and simply
  // never appeared.
  it("builds a card for a project the briefing does not carry", () => {
    state.briefing = { projects: [], pausedProjects: [], generalTasks: [] };
    state.offBoard = {
      "En attente": [offBoardRow("w1", "Validation des maquettes", "En attente", "p-ghost")],
    };
    render();
    expect(container.textContent).toContain("Refonte site");
    expect(container.textContent).toContain("Validation des maquettes");
    // …and it lands in its client's band rather than under "No client".
    expect(container.textContent).toContain("Webdentiste");
  });

  // The empty state is a claim about the user's workload. It counted the briefing only, so a
  // board whose only work is parked said "Nothing open in TOSSE" above a list of tasks.
  it("does not claim the board is empty while listing off-board tasks", () => {
    state.briefing = { projects: [], pausedProjects: [], generalTasks: [] };
    state.offBoard = { "En attente": [offBoardRow("w1", "Retour du client", "En attente", null)] };
    render();
    expect(container.textContent).not.toContain("Nothing open in TOSSE");
  });
});

describe("the toolbar totals", () => {
  // The header counted `projects[].tasks` only, so a board whose work is project-less
  // reported nothing at all while rendering a row right below.
  it("counts project-less tasks", () => {
    render();
    const counts = container.querySelector("[class*='toolbarCounts']");
    expect(counts?.textContent).toContain("1");
    expect(counts?.textContent).toContain("À faire");
  });
});
