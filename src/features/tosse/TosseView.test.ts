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
import type { TosseBriefing, TosseTask } from "../../ipc/client";

const REFUSAL = "Task is blocked by « Lot 1 » and cannot be started";

// What each hook hands back, so a single test can put one mutation into its error state.
const state = {
  briefing: undefined as TosseBriefing | undefined,
  taskStatusError: null as Error | null,
};

const mutation = () => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  error: null as Error | null,
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
  useSetTosseTaskStatus: () => ({ ...mutation(), error: state.taskStatusError }),
  useSetTosseProjectStatus: () => mutation(),
  useCreateTosseTask: () => mutation(),
  useTosseWebUrl: () => ({ data: "https://tosse.example", error: null }),
}));

// The opener plugin has no Tauri host under vitest.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { TosseView } from "./TosseView";

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
  state.taskStatusError = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render() {
  act(() => root.render(createElement(TosseView)));
}

describe("the « No project » band", () => {
  it("renders its tasks", () => {
    render();
    expect(container.textContent).toContain("Déclarer l'URSSAF");
    expect(container.textContent).toContain("No project");
  });

  // ⚠️ THE regression. Verified to fail before the fix: the band had no error surface at
  // all, so this text appeared nowhere.
  it("shows why a status write was refused", () => {
    state.taskStatusError = new Error(REFUSAL);
    render();
    expect(container.textContent).toContain(REFUSAL);
  });

  it("says nothing when no write has failed", () => {
    render();
    expect(container.textContent).not.toContain(REFUSAL);
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
