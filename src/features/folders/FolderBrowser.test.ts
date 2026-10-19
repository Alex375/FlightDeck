// `RemoteFolderDialog` against a mocked conversations store: the three server reads it
// makes (`listRemoteDir`, `listRemoteRepos`, `prepareRemoteDir`) are stubs over a tiny
// in-memory tree. Built with createElement in a `*.test.ts` file + react-dom/client,
// same discipline as ServerStatusPanel.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FolderListing } from "../../ipc/client";

type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

const mocks = vi.hoisted(() => ({
  listRemoteDir: vi.fn(),
  listRemoteRepos: vi.fn(),
  prepareRemoteDir: vi.fn(),
}));

vi.mock("../../store/conversationsStore", () => ({
  useConversationsStore: { getState: () => mocks },
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteFolderDialog } from "./FolderBrowser";
import { useDisplay } from "../../store/display";
import styles from "./FolderBrowser.module.css";

const HOME = "/home/alex";
/** Folder → its sub-folders; the git work trees are listed apart. */
let tree: Record<string, string[]>;
let gitDirs: Set<string>;

function listing(path: string): Outcome<FolderListing> {
  const p = path || HOME;
  if (!(p in tree)) return { ok: true, data: { path: p, exists: false, is_repo: false, dirs: [], repos: [] } };
  const dirs = tree[p];
  const child = (d: string) => (p === "/" ? `/${d}` : `${p}/${d}`);
  return {
    ok: true,
    data: { path: p, exists: true, is_repo: gitDirs.has(p), dirs, repos: dirs.filter((d) => gitDirs.has(child(d))) },
  };
}

let container: HTMLDivElement;
let root: Root;
let onOpen: Mock<(path: string) => void>;
let onClose: Mock<() => void>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lays nothing out, so it has no scrollIntoView (the selected row is kept in view).
  Element.prototype.scrollIntoView = vi.fn();
  useDisplay.getState().set({ folderBrowserView: "columns" });
  tree = {
    "/": ["home", "srv"],
    "/home": ["alex"],
    [HOME]: ["code", "Documents", "app"],
    [`${HOME}/code`]: ["api", "web"],
    [`${HOME}/code/api`]: [],
    [`${HOME}/code/web`]: [],
    [`${HOME}/app`]: [],
    [`${HOME}/Documents`]: [],
    "/srv": ["data"],
    "/srv/data": [],
  };
  gitDirs = new Set([`${HOME}/app`, `${HOME}/code/api`]);
  mocks.listRemoteDir.mockReset().mockImplementation(async (_m: string, p: string) => listing(p));
  mocks.listRemoteRepos.mockReset().mockResolvedValue({ ok: true, data: [`${HOME}/app`, `${HOME}/code/api`] });
  mocks.prepareRemoteDir.mockReset().mockImplementation(async (_m: string, p: string) => {
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    if (!(parent in tree)) return { ok: false, error: "The parent folder doesn't exist on the server." };
    tree[p] = [];
    tree[parent] = [...tree[parent], p.slice(p.lastIndexOf("/") + 1)];
    return { ok: true };
  });
  onOpen = vi.fn<(path: string) => void>();
  onClose = vi.fn<() => void>();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function mount() {
  act(() => {
    root.render(
      createElement(RemoteFolderDialog, {
        machine: { id: "m1", label: "box", user: "alex", host: "box.lan" },
        onOpen,
        onClose,
      }),
    );
  });
  await settle();
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const input = () => document.querySelector('input[aria-label="Filter folders or type a path"]') as HTMLInputElement;
const rowLabels = () =>
  Array.from(document.querySelectorAll('[role="option"]')).map((r) => r.querySelector('[class*="rowLabel"]')?.textContent);
const crumbs = () => (document.querySelector('nav[aria-label="Folder path"]')?.textContent ?? "").trim();
const button = (name: string) =>
  Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(name)) as HTMLButtonElement;

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(key: string, opts: KeyboardEventInit = {}) {
  act(() => {
    (document.activeElement ?? input()).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));
  });
  await settle();
}
async function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

describe("RemoteFolderDialog", () => {
  it("opens at the server's real home, folders sorted, git ones marked", async () => {
    await mount();
    expect(mocks.listRemoteDir).toHaveBeenCalledWith("m1", "");
    expect(rowLabels()).toEqual(["app", "code", "Documents"]);
    expect(dialog().querySelectorAll('[class*="gitPill"]')).toHaveLength(1);
    expect(dialog().textContent).toContain(`Starts in${HOME}`);
    expect(dialog().textContent).toContain("alex@box.lan");
  });

  it("typing then Enter goes into the first match", async () => {
    await mount();
    await type("co");
    expect(rowLabels()[0]).toBe("code");
    await press("Enter");
    expect(mocks.listRemoteDir).toHaveBeenLastCalledWith("m1", `${HOME}/code`);
    expect(rowLabels()).toEqual(["api", "web"]);
    expect(input().value).toBe("");
  });

  it("Backspace on an empty input goes up; the arrows move the selection", async () => {
    await mount();
    await click(Array.from(document.querySelectorAll('[role="option"]'))[1]);
    expect(crumbs()).toContain("code");
    await press("Backspace");
    expect(mocks.listRemoteDir).toHaveBeenLastCalledWith("m1", HOME);
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Enter");
    expect(mocks.listRemoteDir).toHaveBeenLastCalledWith("m1", `${HOME}/Documents`);
  });

  it("a typed path goes there; ~ is the server's home", async () => {
    await mount();
    await type("/srv");
    expect(rowLabels()).toEqual(["Go to /srv"]);
    await press("Enter");
    expect(rowLabels()).toEqual(["data"]);
    await type("~/code");
    await press("Enter");
    expect(mocks.listRemoteDir).toHaveBeenLastCalledWith("m1", `${HOME}/code`);
  });

  it("a typed path that doesn't exist offers to create it, and goes in", async () => {
    await mount();
    await type("~/new-project");
    await press("Enter");
    expect(dialog().textContent).toContain("This folder doesn't exist yet");
    expect(button("Open here").disabled).toBe(true);
    await click(button("Create folder"));
    expect(mocks.prepareRemoteDir).toHaveBeenCalledWith("m1", `${HOME}/new-project`);
    expect(crumbs()).toContain("new-project");
    expect(button("Open here").disabled).toBe(false);
  });

  it("a create the server refuses says why, in the card", async () => {
    await mount();
    await type("/nope/deeper");
    await press("Enter");
    await click(button("Create folder"));
    expect(dialog().textContent).toContain("The parent folder doesn't exist on the server.");
  });

  it("a listing that fails says why, and Retry asks again", async () => {
    mocks.listRemoteDir.mockResolvedValueOnce({ ok: false, error: "Couldn't reach box.lan." });
    await mount();
    expect(dialog().textContent).toContain("Couldn't open this folder");
    expect(dialog().textContent).toContain("Couldn't reach box.lan.");
    await click(button("Retry"));
    expect(rowLabels()).toEqual(["app", "code", "Documents"]);
  });

  it("a repository search that fails says so — not 'none found'", async () => {
    mocks.listRemoteRepos.mockResolvedValueOnce({ ok: false, error: "The search for repositories took too long." });
    await mount();
    expect(dialog().textContent).toContain("Couldn't look for repositories: The search for repositories took too long.");
    expect(dialog().textContent).not.toContain("No git repository found");
  });

  it("only the last navigation asked lands", async () => {
    await mount();
    let releaseSlow: (v: Outcome<FolderListing>) => void = () => {};
    mocks.listRemoteDir.mockImplementationOnce(() => new Promise((r) => (releaseSlow = r)));
    await click(Array.from(document.querySelectorAll('[role="option"]'))[1]); // code (slow)
    await type("/srv");
    await press("Enter");
    expect(rowLabels()).toEqual(["data"]);
    await act(async () => releaseSlow(listing(`${HOME}/code`)));
    await settle();
    expect(rowLabels()).toEqual(["data"]);
  });

  it("New folder creates in the current folder and goes in; a taken name is refused", async () => {
    await mount();
    await click(button("New folder"));
    const name = () => document.querySelector('input[aria-label="Name of the new folder"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(name(), "code");
      name().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(dialog().textContent).toContain("A folder with this name is already here.");
    act(() => {
      setter.call(name(), "fresh");
      name().dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      name().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(mocks.prepareRemoteDir).toHaveBeenCalledWith("m1", `${HOME}/fresh`);
    expect(crumbs()).toContain("fresh");
  });

  it("Open here, ⌘↵ and a row's Open hand back the folder", async () => {
    await mount();
    await click(button("Open here"));
    expect(onOpen).toHaveBeenLastCalledWith(HOME);
    await press("Enter", { metaKey: true });
    expect(onOpen).toHaveBeenCalledTimes(2);
    const appRow = document.querySelector('[role="option"]')!;
    await click(appRow.querySelector('[class*="rowOpen"]')!);
    expect(onOpen).toHaveBeenLastCalledWith(`${HOME}/app`);
    expect(mocks.listRemoteDir).toHaveBeenCalledTimes(1); // Open didn't navigate
  });

  it("Escape clears the filter first, then closes — and never reaches the window", async () => {
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    await mount();
    await type("zz");
    await press("Escape");
    expect(input().value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowEscape).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowEscape);
  });
});

describe("RemoteFolderDialog — columns", () => {
  /** Each parent column: its folders, and the one selected on the way down. */
  const parentColumns = () =>
    Array.from(document.querySelectorAll(`.${styles.column}`)).map((col) => ({
      names: Array.from(col.querySelectorAll(`.${styles.colName}`)).map((n) => n.textContent),
      selected: col.querySelector("[data-selected]")?.querySelector(`.${styles.colName}`)?.textContent ?? null,
      current: col.querySelector('[data-selected="current"]') !== null,
    }));
  const colRow = (name: string) =>
    Array.from(document.querySelectorAll(`.${styles.colRow}`)).find(
      (r) => r.querySelector(`.${styles.colName}`)?.textContent === name,
    )!;

  it("opens a folder to the right of its parent, the way down selected", async () => {
    await mount();
    expect(parentColumns()).toEqual([]);
    await click(Array.from(document.querySelectorAll('[role="option"]'))[1]); // code
    expect(parentColumns()).toEqual([{ names: ["app", "code", "Documents"], selected: "code", current: true }]);
    expect(rowLabels()).toEqual(["api", "web"]);
    await click(document.querySelector('[role="option"]')!); // api
    expect(parentColumns()).toEqual([
      { names: ["app", "code", "Documents"], selected: "code", current: false },
      { names: ["api", "web"], selected: "api", current: true },
    ]);
    expect(dialog().textContent).toContain(`Starts in${HOME}/code/api`);
  });

  it("another folder in a parent column goes there; the selected one closes the columns past it", async () => {
    await mount();
    await click(Array.from(document.querySelectorAll('[role="option"]'))[1]); // code
    await click(document.querySelector('[role="option"]')!); // api
    await click(colRow("web"));
    expect(mocks.listRemoteDir).toHaveBeenLastCalledWith("m1", `${HOME}/code/web`);
    expect(parentColumns().map((c) => c.selected)).toEqual(["code", "web"]);
    await click(colRow("code"));
    expect(parentColumns()).toEqual([{ names: ["app", "code", "Documents"], selected: "code", current: true }]);
    expect(rowLabels()).toEqual(["api", "web"]);
  });

  it("→ opens the selected folder, ← goes back to its parent", async () => {
    await mount();
    await type("co");
    await press("ArrowRight");
    expect(mocks.listRemoteDir).toHaveBeenLastCalledWith("m1", `${HOME}/code`);
    expect(parentColumns().map((c) => c.selected)).toEqual(["code"]);
    await press("ArrowLeft");
    expect(mocks.listRemoteDir).toHaveBeenLastCalledWith("m1", HOME);
    expect(parentColumns()).toEqual([]);
  });

  it("reads the parent columns of a typed path", async () => {
    await mount();
    await type("~/code/api");
    await press("Enter");
    expect(mocks.listRemoteDir).toHaveBeenCalledWith("m1", `${HOME}/code`);
    expect(parentColumns().map((c) => c.selected)).toEqual(["code", "api"]);
  });

  it("a parent column that fails to read says why, and tries again", async () => {
    await mount();
    mocks.listRemoteDir.mockImplementation(async (_m: string, p: string) =>
      p === `${HOME}/code` ? { ok: false, error: "Connection reset." } : listing(p),
    );
    await type("~/code/api");
    await press("Enter");
    expect(dialog().querySelector(`.${styles.column}`)?.nextElementSibling?.textContent).toContain("Connection reset.");
    mocks.listRemoteDir.mockImplementation(async (_m: string, p: string) => listing(p));
    await click(Array.from(dialog().querySelectorAll(`.${styles.column} button`)).find((b) => b.textContent === "Try again")!);
    expect(parentColumns().map((c) => c.selected)).toEqual(["code", "api"]);
  });

  it("a folder just created shows in its parent column", async () => {
    await mount();
    await click(button("New folder"));
    const name = document.querySelector('input[aria-label="Name of the new folder"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(name, "fresh");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(parentColumns()).toEqual([{ names: ["app", "code", "Documents", "fresh"], selected: "fresh", current: true }]);
  });

  it("the list view has no parent columns, and the choice is remembered", async () => {
    await mount();
    await click(Array.from(document.querySelectorAll('[role="option"]'))[1]); // code
    expect(parentColumns()).toHaveLength(1);
    await click(dialog().querySelector('button[title^="List"]')!);
    expect(useDisplay.getState().folderBrowserView).toBe("list");
    expect(parentColumns()).toEqual([]);
    expect(rowLabels()).toEqual(["api", "web"]);
  });
});
