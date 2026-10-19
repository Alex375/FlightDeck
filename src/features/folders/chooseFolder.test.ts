// `chooseFolder` — the one "pick a folder on this Mac" entry point — and the host that
// renders it: the preference picks Flight Deck's browser or the system picker, a request
// is answered exactly once, and the browser reads this Mac through the local commands.
// Built with createElement in a `*.test.ts` file + react-dom/client, same discipline as
// FolderBrowser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pickFolder: vi.fn(),
  listLocalDir: vi.fn(),
  listLocalRepos: vi.fn(),
  prepareLocalDir: vi.fn(),
}));

vi.mock("../../ipc/pickFolder", () => ({ pickFolder: mocks.pickFolder }));
vi.mock("../../ipc/client", () => ({
  commands: {
    listLocalDir: mocks.listLocalDir,
    listLocalRepos: mocks.listLocalRepos,
    prepareLocalDir: mocks.prepareLocalDir,
  },
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDisplay } from "../../store/display";
import { chooseFolder, settleFolderChoice, useFolderChooser } from "./chooseFolder";
import { FolderChooserHost } from "./FolderChooserHost";
import { GUARDED_FOLDERS_NOTE, localFolderSource } from "./folderSources";

const HOME = "/Users/demo";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
  useDisplay.getState().set({ folderBrowser: true });
  useFolderChooser.setState({ pending: null });
  mocks.pickFolder.mockReset().mockResolvedValue("/picked/natively");
  mocks.listLocalDir.mockReset().mockImplementation(async (path: string) => ({
    status: "ok",
    data: { path: path || HOME, exists: true, is_repo: false, dirs: ["Repos", "Documents"], repos: [] },
  }));
  mocks.listLocalRepos.mockReset().mockResolvedValue({ status: "ok", data: { paths: [`${HOME}/Repos/app`], truncated: false } });
  mocks.prepareLocalDir.mockReset().mockResolvedValue({ status: "ok", data: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(FolderChooserHost)));
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

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const button = (name: string) =>
  Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(name)) as HTMLButtonElement;

/** Open a request and let its dialog load. The answer comes back wrapped: an async
 *  function returning a bare promise would wait for the dialog to be answered. */
async function ask(req: Parameters<typeof chooseFolder>[0]): Promise<{ answer: Promise<string | null> }> {
  let answer: Promise<string | null> = Promise.resolve(null);
  act(() => {
    answer = chooseFolder(req);
  });
  await settle();
  return { answer };
}

describe("chooseFolder", () => {
  it("uses the system picker when the folder browser is off", async () => {
    useDisplay.getState().set({ folderBrowser: false });
    await expect(chooseFolder({ title: "Add a folder to search" })).resolves.toBe("/picked/natively");
    expect(mocks.pickFolder).toHaveBeenCalledWith("Add a folder to search");
    expect(dialog()).toBeNull();
  });

  it("opens the browser on this Mac's home, with the caller's words", async () => {
    const { answer } = await ask({ title: "Add a folder to search", confirmLabel: "Add" });
    expect(mocks.listLocalDir).toHaveBeenCalledWith("");
    expect(dialog()!.textContent).toContain("Add a folder to search");
    expect(dialog()!.textContent).toContain("On this");
    expect(dialog()!.textContent).toContain(`Folder${HOME}`);
    await act(async () => button("Add").click());
    await expect(answer).resolves.toBe(HOME);
    expect(dialog()).toBeNull();
    expect(mocks.pickFolder).not.toHaveBeenCalled();
  });

  it("answers null when the browser is closed", async () => {
    const { answer } = await ask({ title: "Choose" });
    await act(async () => button("Cancel").click());
    await expect(answer).resolves.toBeNull();
  });

  it("System picker… closes the browser and answers with the system's choice", async () => {
    const { answer } = await ask({ title: "Open a folder in the IDE" });
    await act(async () => button("System picker").click());
    await expect(answer).resolves.toBe("/picked/natively");
    expect(mocks.pickFolder).toHaveBeenCalledWith("Open a folder in the IDE");
    expect(dialog()).toBeNull();
  });

  it("a second request answers the first one cancelled; a stale settle does nothing", async () => {
    const { answer: first } = await ask({ title: "First" });
    const staleId = useFolderChooser.getState().pending!.id;
    const { answer: second } = await ask({ title: "Second" });
    await expect(first).resolves.toBeNull();
    expect(dialog()!.textContent).toContain("Second");
    settleFolderChoice(staleId, "/nope");
    expect(useFolderChooser.getState().pending).not.toBeNull();
    await act(async () => button("Choose").click());
    await expect(second).resolves.toBe(HOME);
  });
});

describe("localFolderSource", () => {
  it("says where it didn't search, and when it stopped early", async () => {
    const res = await localFolderSource.findRepos();
    expect(res).toEqual({ ok: true, data: { paths: [`${HOME}/Repos/app`], note: GUARDED_FOLDERS_NOTE } });
    mocks.listLocalRepos.mockResolvedValueOnce({ status: "ok", data: { paths: [], truncated: true } });
    const stopped = await localFolderSource.findRepos();
    expect(stopped.ok && stopped.data.note).toContain("stopped after 3 seconds");
  });

  it("keeps a failure as words", async () => {
    mocks.listLocalDir.mockResolvedValueOnce({ status: "error", error: "Flight Deck isn't allowed to open this folder." });
    await expect(localFolderSource.list("/Users/demo/Documents")).resolves.toEqual({
      ok: false,
      error: "Flight Deck isn't allowed to open this folder.",
    });
    mocks.listLocalRepos.mockRejectedValueOnce(new Error("invoke failed"));
    await expect(localFolderSource.findRepos()).resolves.toEqual({ ok: false, error: "invoke failed" });
  });
});
