// The project-default rules, end to end through TaskLaunchProvider: when does a launch
// write its place as the project's default (its pin), and when must it NOT?
//
// `launchTarget` / `dialogPinsDefault` are unit-tested on their own; this locks down the
// WIRING around them — the pin is written only AFTER the launch went through, a refused pin
// is said out loud, a one-off place never moves an existing default, and the dialog's
// "Make default" toggle is the only way to move it.
//
// Renders through react-dom/client (zustand stores need a real client render). `*.test.ts`
// (the vitest glob), so elements are built with createElement — no JSX.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TosseProjectRepo } from "../../ipc/client";
import type { LaunchTask, PickupSupport } from "./taskPrompts";

// ── Controlled mocks ────────────────────────────────────────────────────────────────────

const state = {
  pins: [] as TosseProjectRepo[],
  cache: "available" as PickupSupport,
};

const mutateAsync = vi.fn<(v: { projectId: string; repoId: string | null }) => Promise<null>>();
const launchTaskConversation = vi.fn();

vi.mock("../../ipc/useTosse", () => ({
  useTosseProjectRepos: () => ({ data: state.pins }),
  useTosseRepoLinks: () => ({ data: undefined }),
  useLinkTosseProjectRepo: () => ({ mutateAsync }),
}));

vi.mock("./taskConversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./taskConversation")>()),
  launchTaskConversation: (req: unknown) => launchTaskConversation(req),
}));

vi.mock("./taskPrompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./taskPrompts")>()),
  pickupSupportFromCache: () => state.cache,
  pickupSupport: () => Promise.resolve(state.cache),
}));

vi.mock("./pickupPlugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pickupPlugin")>()),
  activationProblem: () => null,
  findPickupPlugin: () => Promise.resolve(null),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { TaskLaunchProvider, useTaskLaunch, type LaunchOptions } from "./TaskLaunch";
import { useConversationsStore, type Machine, type Repo } from "../../store/conversationsStore";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const PROJECT = "p-1";
const MAC: Repo = { id: "r-mac", path: "/Users/me/Repos/app", addedAt: 1, machineId: null };
const SERVER: Repo = { id: "r-srv", path: "/home/me/app", addedAt: 2, machineId: "m-base" };
const MACHINES = [
  { id: "m-base", label: "Base", host: "base.local", port: 22, user: "me" } as unknown as Machine,
];

const TASK: LaunchTask = {
  id: "t-1",
  title: "Fix the login",
  status: "À faire",
  priority: null,
  kind: null,
  assignedTo: null,
  dueDate: null,
  projectName: "App",
  notes: null,
  context: null,
  content: null,
  blockedBy: [],
};

const OUTCOME = { convId: "c-1", pickup: null, plugin: { kind: "present", plugin: "tosse-workflow" } };

/** A promise whose resolution the test controls — to assert ordering. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Harness ─────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

/** Calls `api.launch` once on mount — the tiny consumer the provider serves. */
function Launcher({ opts }: { opts?: LaunchOptions }) {
  const api = useTaskLaunch();
  useEffect(() => {
    api?.launch(TASK, PROJECT, "pickup", opts);
    // Once: the test drives exactly one press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function render(opts?: LaunchOptions) {
  act(() =>
    root.render(
      createElement(TaskLaunchProvider, {
        onOpenConversation: () => {},
        children: createElement(Launcher, { opts }),
      }),
    ),
  );
}

/** Let the launch's promise chain (and any effect probes) settle. */
async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function dialog(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[role='dialog']");
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  state.pins = [];
  state.cache = "available";
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue(null);
  launchTaskConversation.mockReset();
  launchTaskConversation.mockResolvedValue(OUTCOME);
  useConversationsStore.setState({ repos: [MAC, SERVER], machines: MACHINES });
});

afterEach(() => {
  // The dialog's pending launch lives in a MODULE-level store: Escape closes it so the next
  // test does not mount with the previous one's dialog already open.
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

// ── One click (folder known, /pickup available) ─────────────────────────────────────────

describe("one-click Start from the drop-down", () => {
  it("remembers the first place as the default — only after the launch went through", async () => {
    const launch = deferred<typeof OUTCOME>();
    launchTaskConversation.mockReturnValue(launch.promise);
    render({ repoId: SERVER.id });
    await flush();
    expect(dialog()).toBeNull();
    expect(launchTaskConversation).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: SERVER.id, mode: "pickup" }),
    );
    // Launch still in flight: nothing written yet.
    expect(mutateAsync).not.toHaveBeenCalled();
    launch.resolve(OUTCOME);
    await flush();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ projectId: PROJECT, repoId: SERVER.id });
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("writes no default when the launch failed, and says why it failed", async () => {
    launchTaskConversation.mockRejectedValue(new Error("Base is unreachable"));
    render({ repoId: SERVER.id });
    await flush();
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Base is unreachable");
  });

  it("says so when the default could not be remembered", async () => {
    mutateAsync.mockRejectedValue(new Error("database is locked"));
    render({ repoId: SERVER.id });
    await flush();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const toast = container.querySelector("[role='alert']")?.textContent ?? "";
    expect(toast).toContain("could not be remembered as the project's default");
    expect(toast).toContain("database is locked");
  });

  it("never moves an existing default for a one-off place", async () => {
    state.pins = [{ project_id: PROJECT, repo_id: MAC.id }];
    render({ repoId: SERVER.id });
    await flush();
    expect(launchTaskConversation).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: SERVER.id }),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  // A server whose catalogue no session has reported yet starts in one click (the plugin
  // is assumed on there) — and it must still be the PICKED place, not the default.
  it("launches a picked server place in one click while its catalogue is unknown", async () => {
    state.cache = "unknown";
    state.pins = [{ project_id: PROJECT, repo_id: MAC.id }];
    render({ repoId: SERVER.id });
    await flush();
    expect(dialog()).toBeNull();
    expect(launchTaskConversation).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: SERVER.id }),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

// ── The dialog: the server is known to lack /pickup, so it opens (an UNKNOWN remote
// catalogue launches in one click since 806faa1 — the plugin is assumed on there) ──────────────────────────────────────

describe("the Start dialog", () => {
  it("does not move the default when Start is pressed on a one-off place", async () => {
    state.cache = "absent";
    state.pins = [{ project_id: PROJECT, repo_id: MAC.id }];
    render({ repoId: SERVER.id });
    await flush();
    const d = dialog();
    expect(d).not.toBeNull();
    expect(launchTaskConversation).not.toHaveBeenCalled();
    // The one-off place offers to become the default, but is not it.
    expect(button(d!, "Make default").getAttribute("aria-pressed")).toBe("false");
    act(() => button(d!, "Start").click());
    await flush();
    expect(launchTaskConversation).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: SERVER.id }),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("remembers the chosen place when the project has no default yet", async () => {
    state.cache = "absent";
    render({ repoId: SERVER.id });
    await flush();
    const d = dialog();
    expect(d).not.toBeNull();
    // No default yet: the toggle starts ON — the first answer becomes it.
    expect(button(d!, "Default").getAttribute("aria-pressed")).toBe("true");
    act(() => button(d!, "Start").click());
    await flush();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ projectId: PROJECT, repoId: SERVER.id });
  });

  it("writes no default when the dialog's launch failed, and keeps the dialog up to say why", async () => {
    state.cache = "absent";
    launchTaskConversation.mockRejectedValue(new Error("Base is unreachable"));
    render({ repoId: SERVER.id });
    await flush();
    const d = dialog()!;
    // No default yet: the toggle is ON, so only the launch's outcome gates the write.
    expect(button(d, "Default").getAttribute("aria-pressed")).toBe("true");
    act(() => button(d, "Start").click());
    await flush();
    expect(launchTaskConversation).toHaveBeenCalledTimes(1);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Base is unreachable");
  });

  it("says so in the dialog when the chosen place could not be remembered", async () => {
    state.cache = "absent";
    mutateAsync.mockRejectedValue(new Error("database is locked"));
    render({ repoId: SERVER.id });
    await flush();
    act(() => button(dialog()!, "Start").click());
    await flush();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    // The conversation opened, but the dialog stays up: the refusal is never dropped.
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("could not be remembered for the project");
    expect(text).toContain("database is locked");
  });

  it("moves the default when the user asks for it with « Make default »", async () => {
    state.cache = "absent";
    state.pins = [{ project_id: PROJECT, repo_id: MAC.id }];
    render({ repoId: SERVER.id });
    await flush();
    const d = dialog()!;
    act(() => button(d, "Make default").click());
    expect(button(d, "Default").getAttribute("aria-pressed")).toBe("true");
    act(() => button(d, "Start").click());
    await flush();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ projectId: PROJECT, repoId: SERVER.id });
  });
});
