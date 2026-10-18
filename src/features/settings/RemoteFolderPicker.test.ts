// The remote folder picker lists a server's repositories and folders over SSH. When that fails
// (a changed host identity, a refused key, a server that is off), the core already says why in a
// sentence the user can act on: the picker must show it, never an endless "…" placeholder or an
// empty list that reads as "no repositories".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listRemoteRepos = vi.fn();
const listRemoteDir = vi.fn();
const prepareRemoteDir = vi.fn();
vi.mock("../../ipc/client", () => ({
  commands: {
    listRemoteRepos: (...a: unknown[]) => listRemoteRepos(...a),
    listRemoteDir: (...a: unknown[]) => listRemoteDir(...a),
    prepareRemoteDir: (...a: unknown[]) => prepareRemoteDir(...a),
  },
  events: {},
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConversationsStore } from "../../store/conversationsStore";
import { RemoteFolderPicker } from "./RemoteFolderPicker";

const HOST_KEY_CHANGED = "this server's identity has changed since this Mac last connected to it";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPicker() {
  await act(async () => {
    root.render(createElement(RemoteFolderPicker, { machineId: "m1", machineLabel: "Base", onOpen: () => {} }));
  });
  await act(async () => {});
}

describe("RemoteFolderPicker", () => {
  it("shows the ssh error instead of an endless placeholder", async () => {
    listRemoteRepos.mockResolvedValue({ status: "error", error: HOST_KEY_CHANGED });
    listRemoteDir.mockResolvedValue({ status: "error", error: HOST_KEY_CHANGED });
    await renderPicker();
    expect(container.textContent).toContain(HOST_KEY_CHANGED);
    expect(container.textContent).toContain("Couldn't look for repositories on Base");
    expect(container.textContent).toContain("Couldn't list the folders on Base");
    expect(container.textContent).not.toContain("…");
    expect(container.textContent).not.toContain("Looking at");
  });

  it("lists repositories and folders when the server answers", async () => {
    listRemoteRepos.mockResolvedValue({ status: "ok", data: ["/home/u/app"] });
    listRemoteDir.mockResolvedValue({ status: "ok", data: { path: "/home/u", dirs: ["app"] } });
    await renderPicker();
    expect(container.textContent).toContain("/home/u/app");
    expect(container.textContent).toContain("app/");
    expect(container.textContent).not.toContain("Couldn't");
  });
});

describe("store wrappers", () => {
  it("forward the ssh error", async () => {
    listRemoteRepos.mockResolvedValue({ status: "error", error: HOST_KEY_CHANGED });
    listRemoteDir.mockResolvedValue({ status: "error", error: HOST_KEY_CHANGED });
    const store = useConversationsStore.getState();
    expect(await store.listRemoteRepos("m1")).toEqual({ ok: false, error: HOST_KEY_CHANGED });
    expect(await store.listRemoteDir("m1", "")).toEqual({ ok: false, error: HOST_KEY_CHANGED });
  });
});
