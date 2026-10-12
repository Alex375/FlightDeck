// Git mode on a conversation running on a PAIRED SERVER: the Git workspace runs THIS Mac's git
// against the server's path — a failed read, or an unrelated same-path clone's status, diffs and
// history passed off as the server's. It must not mount there; the side region says why instead,
// beside the conversation. `gitOpen` is layout-wide, so a local conversation keeps its workspace.
//
// The area's heavy children are stubbed: what matters is which of them MOUNTS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mounted = vi.hoisted(() => ({ git: vi.fn(), pane: vi.fn() }));
vi.mock("../git/GitWorkspace", () => ({
  GitWorkspace: () => {
    mounted.git();
    return null;
  },
}));
vi.mock("./ConversationPane", () => ({
  ConversationPane: () => {
    mounted.pane();
    return null;
  },
}));
vi.mock("./ConductorSidebar", () => ({ ConductorSidebar: () => null }));
vi.mock("./ConversationSidePanel", () => ({ ConversationSidePanel: () => null }));
vi.mock("./SidePanel", () => ({ SidePanel: () => null }));
vi.mock("../../store/conversationsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../store/conversationsStore")>()),
  // Selecting a conversation replays its history: not this test's subject.
  loadConversationHistory: vi.fn(async () => {}),
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConductorConversation } from "./ConductorConversation";
import { useConversationsStore, type Conversation } from "../../store/conversationsStore";
import { useEditorStore } from "../editor/editorStore";
import { useDisplay } from "../../store/display";
import { gitUnavailable } from "../../store/remoteGates";

let container: HTMLDivElement;
let root: Root;

const conv = (id: string, repoId: string) =>
  ({ id, repoId, cwd: "/Users/me/app", liveCwd: null, kind: "claude", name: id }) as unknown as Conversation;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useDisplay.getState().set({ conversationSidePanel: false });
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Base" }] as never,
    repos: [
      { id: "r-remote", path: "/Users/me/app", addedAt: 1, machineId: "m1" },
      { id: "r-local", path: "/Users/me/app", addedAt: 1, machineId: null },
    ],
    conversations: [conv("c-remote", "r-remote"), conv("c-local", "r-local")],
  });
  useEditorStore.setState({ gitOpen: true, open: false, terminalOpen: false, artifactView: null, tosseTaskView: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useEditorStore.setState({ gitOpen: false });
});

describe("Git mode", () => {
  it("remote: the Git workspace never mounts; the conversation stays, and the region says why", async () => {
    await act(async () => root.render(createElement(ConductorConversation, { active: conv("c-remote", "r-remote") })));
    expect(mounted.git).not.toHaveBeenCalled();
    expect(mounted.pane).toHaveBeenCalled();
    expect(container.textContent).toContain(gitUnavailable("Base"));
  });

  it("local: the Git workspace takes over as before", async () => {
    await act(async () => root.render(createElement(ConductorConversation, { active: conv("c-local", "r-local") })));
    await vi.waitFor(() => expect(mounted.git).toHaveBeenCalled());
    expect(container.textContent).not.toContain("Git views run this Mac's git");
  });
});
