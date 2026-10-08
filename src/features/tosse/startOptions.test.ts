// The Start button's caret menu, driven end to end through the REAL TaskLaunchProvider:
// a project whose CRM repository is cloned in TWO registered folders — one on this Mac,
// one on a paired server — must offer both under « Run on », launch in the one the user
// checks (for this run only, never moving the default), and say so out loud when moving
// the default is refused.
//
// Renders through react-dom/client (NOT renderToStaticMarkup): the view reads zustand
// stores, whose SSR path would feed `useSyncExternalStore` the INITIAL state and never
// observe them. `*.test.ts` (the vitest glob), so elements are built with createElement —
// no JSX.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  TosseBriefing,
  TosseProjectRepo,
  TosseRepoLinksPayload,
  TosseRepository,
  TosseTask,
} from "../../ipc/client";

const PIN_REFUSAL = "CRM said no";

// What each mocked hook hands back. Mutable per test, reset in `beforeEach`.
const state = {
  briefing: undefined as TosseBriefing | undefined,
  pins: [] as TosseProjectRepo[],
  links: undefined as TosseRepoLinksPayload | undefined,
  refusePin: false,
};

// The pin mutation's two entry points, recorded: `mutate` is what « Make default » uses,
// `mutateAsync` is what a launch would use to remember a first default.
const pinMutate = vi.fn(
  (_vars: unknown, opts?: { onError?: (e: Error) => void; onSuccess?: () => void }) => {
    if (state.refusePin) opts?.onError?.(new Error(PIN_REFUSAL));
    else opts?.onSuccess?.();
  },
);
const pinMutateAsync = vi.fn(() => Promise.resolve());

const mutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(() => Promise.resolve()),
  reset: vi.fn(),
  isPending: false,
  variables: undefined,
  error: null as Error | null,
});

vi.mock("../../ipc/useTosse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/useTosse")>()),
  useTosseBriefing: () => ({
    data: state.briefing,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
    dataUpdatedAt: 0,
  }),
  useTosseTaskDetail: () => ({ data: undefined, isLoading: false, error: null }),
  useTosseOffBoard: () => ({ data: [], isLoading: false, error: null }),
  useSetTosseTaskStatus: () => mutation(),
  useSetTosseProjectStatus: () => mutation(),
  useCreateTosseTask: () => mutation(),
  useTosseWebUrl: () => ({ data: "https://tosse.example", error: null }),
  useTosseProjectRepos: () => ({ data: state.pins }),
  useTosseRepoLinks: () => ({ data: state.links }),
  useLinkTosseProjectRepo: () => ({
    ...mutation(),
    mutate: pinMutate,
    mutateAsync: pinMutateAsync,
  }),
  useLocalRepoScan: () => ({ data: undefined, isLoading: false, error: null }),
}));

// The launch itself: recorded, never spawning anything.
const launchSpy = vi.fn((_req: { repoId: string; extra?: string }) =>
  Promise.resolve({
    convId: "conv-new",
    pickup: "available" as const,
    plugin: { kind: "present" as const, plugin: "tosse-workflow" },
  }),
);
vi.mock("./taskConversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./taskConversation")>()),
  launchTaskConversation: (req: { repoId: string; extra?: string }) => launchSpy(req),
}));

// A confirmed `/pickup` in every folder, so a launch takes the one-click path instead of
// opening the dialog.
vi.mock("./taskPrompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./taskPrompts")>()),
  pickupSupportFromCache: () => "available",
}));

// The opener plugin has no Tauri host under vitest.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { TosseView } from "./TosseView";
import { useTosseFold } from "../../store/tosseFold";
import { useConversationsStore, type Machine, type Repo } from "../../store/conversationsStore";

const PROJECT_ID = "p-site";
const LOCAL = "r-local";
const REMOTE = "r-remote";

function task(id: string, status: string, over: Partial<TosseTask> = {}): TosseTask {
  return {
    id,
    title: id,
    status,
    priority: "Moyenne",
    kind: "Dev",
    assignedTo: "Alexandre",
    dueDate: null,
    notes: null,
    subtaskCount: 0,
    subtaskDone: 0,
    ...over,
  };
}

function board(): TosseBriefing {
  return {
    projects: [
      {
        id: PROJECT_ID,
        name: "Refonte site",
        status: "En cours",
        client: null,
        startDate: null,
        dueDate: null,
        tasks: [task("t-1", "À faire", { title: "Build the landing page" })],
        taskCount: 1,
        taskDone: 0,
      },
    ],
    pausedProjects: [],
    generalTasks: [],
  };
}

const repository: TosseRepository = {
  id: "crm-repo",
  name: "site",
  url: "git@github.com:acme/site.git",
  host: "github.com",
  status: "Actif",
  context: null,
  projects: [{ id: PROJECT_ID, name: "Refonte site", status: "En cours" }],
};

/** The repo-links payload: each listed folder matched to the project's CRM repository. */
function linksFor(repoIds: string[]): TosseRepoLinksPayload {
  return {
    connected: true,
    links: repoIds.map(
      (repoId) =>
        ({
          repoId,
          resolved: true,
          remoteUrl: repository.url,
          repository,
          source: "remote",
          manualRepositoryId: null,
        }) as unknown as TosseRepoLinksPayload["links"][number],
    ),
    repositories: [repository],
    error: null,
  };
}

const machine = {
  id: "m-base",
  label: "Base",
  host: "base.local",
  port: 22,
  user: "alex",
  addedAt: 0,
  addresses: [],
} as unknown as Machine;

const localRepo: Repo = { id: LOCAL, path: "/Users/alex/site", addedAt: 0, machineId: null };
const remoteRepo: Repo = { id: REMOTE, path: "/home/alex/site", addedAt: 1, machineId: "m-base" };

/** Two places — the Mac (pinned default) and the server. */
function seedTwoPlaces() {
  useConversationsStore.setState({ repos: [localRepo, remoteRepo], machines: [machine] });
  state.pins = [{ project_id: PROJECT_ID, repo_id: LOCAL }];
  state.links = linksFor([LOCAL, REMOTE]);
}

/** One place — the Mac only. */
function seedOnePlace() {
  useConversationsStore.setState({ repos: [localRepo], machines: [] });
  state.pins = [{ project_id: PROJECT_ID, repo_id: LOCAL }];
  state.links = linksFor([LOCAL]);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  state.briefing = board();
  state.refusePin = false;
  localStorage.clear();
  useTosseFold.setState({ folded: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationsStore.setState({ repos: [], machines: [], conversations: [], activeId: null });
  vi.clearAllMocks();
});

function render() {
  act(() => root.render(createElement(TosseView, { onOpenConversation: () => {} })));
}

/** Open the Start button's caret menu. The popover renders through a portal, so it is
 *  looked up on `document` afterwards. */
function openCaret() {
  const caret = container.querySelector<HTMLButtonElement>(
    "button[title='Choose where to run, or add an instruction'], button[title='Start with an extra instruction']",
  );
  if (!caret) throw new Error("no Start caret on the row");
  act(() => caret.click());
  const pop = document.querySelector<HTMLElement>(".wf-pop");
  if (!pop) throw new Error("the caret menu did not open");
  return pop;
}

function placeRows(pop: HTMLElement) {
  return [...pop.querySelectorAll<HTMLButtonElement>("[role='radio']")];
}

/** The place row (its container) whose label names `machineName`. */
function rowFor(pop: HTMLElement, machineName: string): HTMLElement {
  const radio = placeRows(pop).find((r) => r.textContent?.includes(machineName));
  if (!radio?.parentElement) throw new Error(`no place row for "${machineName}"`);
  return radio.parentElement;
}

/** The bottom launch button — the last button of the popover. */
function goButton(pop: HTMLElement): HTMLButtonElement {
  const buttons = [...pop.querySelectorAll<HTMLButtonElement>("button")];
  const go = buttons[buttons.length - 1];
  if (!go) throw new Error("no bottom Start button");
  return go;
}

/** Click and let the launch promise chain settle. */
async function clickAndSettle(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

/** Type into a React-controlled textarea: the native setter, then an input event. */
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the Start caret menu with two places", () => {
  it("lists both places, the pinned one marked Default and checked", () => {
    seedTwoPlaces();
    render();
    const pop = openCaret();
    expect(pop.textContent).toContain("Run on");
    const radios = placeRows(pop);
    expect(radios).toHaveLength(2);
    // This Mac first, the server after — a stable order that says nothing about the default.
    expect(radios[0].textContent).toContain("This Mac");
    expect(radios[1].textContent).toContain("Base");

    const local = rowFor(pop, "This Mac");
    expect(local.querySelector("[role='radio']")?.getAttribute("aria-checked")).toBe("true");
    expect(local.textContent).toContain("Default");
    expect(local.textContent).not.toContain("Make default");

    const remote = rowFor(pop, "Base");
    expect(remote.querySelector("[role='radio']")?.getAttribute("aria-checked")).toBe("false");
    expect(remote.textContent).toContain("Make default");
    expect(goButton(pop).textContent).toBe("Start on This Mac");
  });

  it("launches in the picked non-default place, without moving the default", async () => {
    seedTwoPlaces();
    render();
    const pop = openCaret();
    const remoteRadio = rowFor(pop, "Base").querySelector<HTMLButtonElement>("[role='radio']")!;
    act(() => remoteRadio.click());
    // Picking a place keeps the drop-down open and moves the check.
    expect(remoteRadio.getAttribute("aria-checked")).toBe("true");
    const go = goButton(pop);
    expect(go.textContent).toBe("Start on Base");
    expect(go.disabled).toBe(false);
    await clickAndSettle(go);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0].repoId).toBe(REMOTE);
    // A default already exists: running elsewhere for one run never writes the pin.
    expect(pinMutate).not.toHaveBeenCalled();
    expect(pinMutateAsync).not.toHaveBeenCalled();
  });

  it("launches in the default folder when the default stays checked", async () => {
    seedTwoPlaces();
    render();
    const pop = openCaret();
    await clickAndSettle(goButton(pop));
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0].repoId).toBe(LOCAL);
    expect(pinMutate).not.toHaveBeenCalled();
    expect(pinMutateAsync).not.toHaveBeenCalled();
  });

  it("says so when moving the default is refused", () => {
    seedTwoPlaces();
    state.refusePin = true;
    render();
    const pop = openCaret();
    const offer = [...rowFor(pop, "Base").querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Make default"),
    );
    if (!offer) throw new Error("no Make default on the server row");
    act(() => offer.click());
    expect(pinMutate).toHaveBeenCalledTimes(1);
    expect(pinMutate.mock.calls[0][0]).toEqual({ projectId: PROJECT_ID, repoId: REMOTE });
    const alert = pop.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Default not saved");
    expect(alert?.textContent).toContain(PIN_REFUSAL);
    // The drop-down stayed open to say it.
    expect(document.querySelector(".wf-pop")).not.toBeNull();
  });
});

/** Two places, and the project has NO default yet. */
function seedTwoPlacesNoDefault() {
  useConversationsStore.setState({ repos: [localRepo, remoteRepo], machines: [machine] });
  state.pins = [];
  state.links = linksFor([LOCAL, REMOTE]);
}

/** Let a launch's promise chain (launch → pin write → toast) run to the end. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

describe("the Start caret menu with two places and no default yet", () => {
  it("remembers the picked place as the default, only AFTER the launch went through", async () => {
    seedTwoPlacesNoDefault();
    render();
    const pop = openCaret();
    // Nothing is checked yet: there is no default to follow, so Start waits for a pick.
    expect(placeRows(pop).every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(goButton(pop).disabled).toBe(true);

    act(() => rowFor(pop, "Base").querySelector<HTMLButtonElement>("[role='radio']")!.click());
    await clickAndSettle(goButton(pop));
    await flush();

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0].repoId).toBe(REMOTE);
    // The first answer becomes the default…
    expect(pinMutateAsync).toHaveBeenCalledTimes(1);
    expect((pinMutateAsync.mock.calls[0] as unknown[])[0]).toEqual({ projectId: PROJECT_ID, repoId: REMOTE });
    // …written after the launch, never before it.
    expect(launchSpy.mock.invocationCallOrder[0]).toBeLessThan(pinMutateAsync.mock.invocationCallOrder[0]);
    expect(pinMutate).not.toHaveBeenCalled();
  });

  it("does not remember a place whose launch failed, and says the launch failed", async () => {
    seedTwoPlacesNoDefault();
    launchSpy.mockImplementationOnce(() => Promise.reject(new Error("server is down")));
    render();
    const pop = openCaret();
    act(() => rowFor(pop, "Base").querySelector<HTMLButtonElement>("[role='radio']")!.click());
    await clickAndSettle(goButton(pop));
    await flush();

    expect(launchSpy).toHaveBeenCalledTimes(1);
    // A failed launch must not leave the project defaulting to the place that just failed.
    expect(pinMutateAsync).not.toHaveBeenCalled();
    expect(pinMutate).not.toHaveBeenCalled();
    const toast = [...document.querySelectorAll("[role='alert']")].find((el) =>
      el.textContent?.includes("server is down"),
    );
    expect(toast).toBeDefined();
  });
});

describe("the Start caret menu with one place", () => {
  it("has no Run on section, and the bottom button needs a note", async () => {
    seedOnePlace();
    render();
    const pop = openCaret();
    expect(pop.textContent).not.toContain("Run on");
    expect(placeRows(pop)).toHaveLength(0);
    const go = goButton(pop);
    expect(go.textContent).toBe("Start with this");
    expect(go.disabled).toBe(true);

    const field = pop.querySelector<HTMLTextAreaElement>("textarea");
    if (!field) throw new Error("no instruction field");
    typeInto(field, "plan it out first");
    expect(goButton(pop).disabled).toBe(false);
    await clickAndSettle(goButton(pop));
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0]).toMatchObject({ repoId: LOCAL, extra: "plan it out first" });
  });
});
