// The conversation surfaces that read or act on THIS Mac's disk, shell or config, on a
// conversation running on a PAIRED SERVER: each is not offered there (or degrades to what can be
// honoured), says why naming the server, and never makes the Mac-side call — while a local
// conversation keeps the surface exactly as before. One file, one stubbed IPC surface, so every
// "no Mac call" assertion is checked against the same spies.
//
// Rendered through react-dom/client (zustand's SSR path would only ever see initial state).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      openInTerminal: vi.fn(() => ok()),
      getOutputStyle: vi.fn(() => ok("default")),
      setOutputStyle: vi.fn(() => ok()),
      readFile: vi.fn(() => ok({ path: "", content: "<p>hi</p>", too_large: false, binary: false, size: 9, mtime_ms: 1 })),
      statFiles: vi.fn(() => ok([])),
      pathExists: vi.fn(async () => true),
      listWorktrees: vi.fn(() => ok([{ path: "/Users/me/app", branch: "main", head: "abc", is_bare: false, is_main: true }])),
    },
    events: { fsChangeEvent: { listen: vi.fn(async () => () => {}) } },
  };
});
vi.mock("../../ipc/client", () => ipc);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The native artifact host has no place in jsdom: record what the viewer asks it to show.
const host = vi.hoisted(() => ({ attach: vi.fn((_el: HTMLElement, _url: string) => () => {}) }));
vi.mock("./artifactHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifactHost")>()),
  attachArtifactHost: host.attach,
}));
// The real panes are heavy (Monaco, xterm) and beside the point: what matters is whether they
// MOUNT — a mounted editor lists, reads and watches this Mac's disk, a mounted terminal opens a PTY.
const panes = vi.hoisted(() => ({ editor: vi.fn(), terminal: vi.fn() }));
vi.mock("../editor/EditorPanel", () => ({
  EditorPanel: () => {
    panes.editor();
    return null;
  },
}));
vi.mock("../terminal/TerminalView", () => ({
  default: () => {
    panes.terminal();
    return null;
  },
}));

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConversationsStore } from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import { useAppErrors } from "../../store/appErrors";
import { useDisplay } from "../../store/display";
import {
  editorUnavailable,
  openInTerminalUnavailable,
  terminalUnavailable,
} from "../../store/remoteGates";
import { OpenInTerminalButton } from "./OpenInTerminalButton";
import { OutputStyleChip } from "./OutputStyleChip";
import { SidePanel } from "./SidePanel";
import { ArtifactViewer } from "./ArtifactViewer";
import { FileMentionProvider, MentionInlineCode, MentionPathChip } from "./FileMention";
import { clearMentionCache } from "./mentionCache";
import { WorktreeIndicator } from "../git/WorktreeIndicator";
import type { Conversation } from "../../store/conversationsStore";

let container: HTMLDivElement;
let root: Root;

function mount(el: ReactElement) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        el,
      ),
    );
  });
}
const flush = () => act(async () => {});
const text = () => container.textContent ?? "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  clearMentionCache();
  useAppErrors.setState({ errors: [] });
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Base" }] as never,
    repos: [
      { id: "r-remote", path: "/Users/me/app", addedAt: 1, machineId: "m1" },
      { id: "r-local", path: "/Users/me/app", addedAt: 1, machineId: null },
    ],
    conversations: [
      { id: "c-remote", repoId: "r-remote", cwd: "/Users/me/app", liveCwd: null, kind: "claude", name: "remote", sessionId: "sid-r" },
      { id: "c-local", repoId: "r-local", cwd: "/Users/me/app", liveCwd: null, kind: "claude", name: "local", sessionId: "sid-l" },
    ] as never,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationStore.setState({ sessions: {} });
});

describe("Open in the system terminal", () => {
  const button = () => container.querySelector('[aria-label="Open the conversation in the system terminal"]') as HTMLButtonElement;

  it("remote: offered as unavailable, the click says why — and runs nothing on this Mac", () => {
    mount(createElement(OpenInTerminalButton, { convId: "c-remote", sessionId: "sid-r", cwd: "/Users/me/app", backend: "claude" }));
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().title).toBe(openInTerminalUnavailable("Base"));
    act(() => button().click());
    expect(ipc.commands.openInTerminal).not.toHaveBeenCalled();
    expect(useAppErrors.getState().errors.map((e) => e.detail)).toEqual([openInTerminalUnavailable("Base")]);
  });

  it("local: unchanged", async () => {
    mount(createElement(OpenInTerminalButton, { convId: "c-local", sessionId: "sid-l", cwd: "/Users/me/app", backend: "claude" }));
    expect(button().getAttribute("aria-disabled")).toBeNull();
    await act(async () => button().click());
    expect(ipc.commands.openInTerminal).toHaveBeenCalledWith("/Users/me/app", "sid-l", "claude");
  });
});

describe("Composer output-style chip", () => {
  it("remote: read-only from the session's own report, never this Mac's settings.json", async () => {
    useConversationStore.getState().ensureSession("c-remote");
    act(() => {
      useConversationStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          "c-remote": { ...s.sessions["c-remote"], state: { output_style: "Explanatory" } as never },
        },
      }));
    });
    mount(createElement(OutputStyleChip, { session: "c-remote" }));
    await flush();
    expect(ipc.commands.getOutputStyle).not.toHaveBeenCalled();
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(text()).toContain("Set on Base");
    expect(text()).not.toContain("Learning"); // no pickable list
    expect(ipc.commands.setOutputStyle).not.toHaveBeenCalled();
  });

  it("remote, not started yet: says where the style is set", () => {
    mount(createElement(OutputStyleChip, { session: "c-remote" }));
    expect(text()).toContain("Set on Base");
  });

  it("local: reads (and offers to write) this Mac's global style", async () => {
    mount(createElement(OutputStyleChip, { session: "c-local" }));
    await flush();
    expect(ipc.commands.getOutputStyle).toHaveBeenCalled();
  });
});

describe("Side region (editor + terminal)", () => {
  const panel = (convId: string) =>
    mount(createElement(SidePanel, { convId, cwd: "/Users/me/app", sideBySide: true, editorOpen: true, terminalOpen: true }));

  it("remote: neither pane mounts (no fs read/watch, no PTY); each says why", () => {
    panel("c-remote");
    expect(panes.editor).not.toHaveBeenCalled();
    expect(panes.terminal).not.toHaveBeenCalled();
    expect(text()).toContain(editorUnavailable("Base"));
    expect(text()).toContain(terminalUnavailable("Base"));
  });

  it("local: both panes mount", async () => {
    panel("c-local");
    await flush();
    expect(panes.editor).toHaveBeenCalled();
    expect(panes.terminal).toHaveBeenCalled();
    expect(text()).not.toContain("this Mac");
  });
});

describe("Artifact viewer", () => {
  const view = (convId: string) => ({
    convId,
    title: "Report",
    favicon: null,
    url: "https://claude.ai/code/artifact/acecfb35-f63b-49c3-b835-d0c856695a94",
    filePath: "/tmp/claude-1000/x/report.html",
    kind: "html" as const,
  });

  it("remote: no read of this Mac's disk — straight to the hosted page", async () => {
    useDisplay.getState().set({ artifactsInApp: true });
    mount(createElement(ArtifactViewer, { view: view("c-remote"), onClose: () => {} }));
    await flush();
    expect(ipc.commands.readFile).not.toHaveBeenCalled();
    expect(ipc.commands.statFiles).not.toHaveBeenCalled();
    expect(host.attach).toHaveBeenCalledWith(expect.anything(), view("c-remote").url);
  });

  it("remote, hosted view off: says where the file is — not that it couldn't be read", async () => {
    useDisplay.getState().set({ artifactsInApp: false });
    mount(createElement(ArtifactViewer, { view: view("c-remote"), onClose: () => {} }));
    await flush();
    expect(ipc.commands.readFile).not.toHaveBeenCalled();
    expect(text()).toContain("This artifact’s file is on Base.");
    expect(text()).not.toContain("couldn’t be read");
    useDisplay.getState().set({ artifactsInApp: true });
  });

  it("local: reads the local file as before", async () => {
    mount(createElement(ArtifactViewer, { view: view("c-local"), onClose: () => {} }));
    await flush();
    expect(ipc.commands.readFile).toHaveBeenCalledWith("/tmp/claude-1000/x/report.html");
  });
});

describe("File mentions", () => {
  const withProvider = (offMac: boolean, child: ReactElement) =>
    createElement(FileMentionProvider, { convId: "c", cwd: "/Users/me/app", offMac, children: child });

  it("remote: a tool-card path is plain text (it names the SERVER's file)", () => {
    mount(withProvider(true, createElement(MentionPathChip, { path: "/Users/me/app/src/a.ts", display: "a.ts", stepRow: false })));
    expect(text()).toBe("a.ts");
    expect(container.querySelector("[data-filelink]")).toBeNull();
  });

  it("remote: a prose path is never stat'ed on this Mac", async () => {
    mount(withProvider(true, createElement(MentionInlineCode, { children: "src/a.ts" })));
    await flush();
    expect(ipc.commands.pathExists).not.toHaveBeenCalled();
  });

  it("local: both stay as before (clickable chip, existence-checked prose)", async () => {
    mount(withProvider(false, createElement(MentionPathChip, { path: "/Users/me/app/src/a.ts", display: "a.ts", stepRow: false })));
    expect(container.querySelector("[data-filelink]")).not.toBeNull();
    mount(withProvider(false, createElement(MentionInlineCode, { children: "src/b.ts" })));
    await flush();
    expect(ipc.commands.pathExists).toHaveBeenCalledWith("/Users/me/app/src/b.ts");
  });
});

describe("Worktree indicator", () => {
  const conv = (id: string) => useConversationsStore.getState().conversations.find((c) => c.id === id) as Conversation;

  it("remote: no git on this Mac, nothing shown", async () => {
    mount(createElement(WorktreeIndicator, { conv: conv("c-remote"), repoPath: "/Users/me/app", machineId: "m1" }));
    await flush();
    expect(ipc.commands.listWorktrees).not.toHaveBeenCalled();
    expect(text()).toBe("");
  });

  it("local: lists the worktrees as before", async () => {
    mount(createElement(WorktreeIndicator, { conv: conv("c-local"), repoPath: "/Users/me/app", machineId: null }));
    await flush();
    expect(ipc.commands.listWorktrees).toHaveBeenCalledWith("/Users/me/app");
    await vi.waitFor(() => expect(text()).toContain("main"));
  });
});
