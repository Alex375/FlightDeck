// The Git status widget, rendered for real: which state reaches the screen for each answer of
// the shared `git status` query, and its COST contract — a remote repository or a relative cwd
// reads nothing, a folded section keeps only its header's observer (the fs listener lives in the
// body), and a figure is a real 0 only when git said 0. What each figure MEANS is pinned by
// features/git/gitStatusSummary.test.ts; the text checks here only prove the right state landed.
//
// Rendered through react-dom/client rather than the server renderer: the zustand stores and the
// query cache are read through subscriptions the SSR path only sees at their initial state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { commands, events, type GitFileEntry, type GitStatus } from "../../../ipc/client";
import { GIT_FS_REFRESH_THROTTLE_MS, useGitAutoRefresh } from "../../../ipc/useGit";
import {
  useConversationsStore,
  type Conversation,
  type Machine,
} from "../../../store/conversationsStore";
import { useConversationStore } from "../../../store/conversationStore";
import { useDisplay } from "../../../store/display";
import { useSidePanelLayout } from "../../../store/sidePanelWidgetsStore";
import { useEditorStore } from "../../editor/editorStore";
import { useGitViewStore } from "../../git/gitViewStore";
import { GitStatusWidget } from "./GitStatusWidget";

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "Git",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: null,
  handle: null,
  liveCwd: null,
  bypassAllowed: false,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "default",
  pendingReminder: null,
  tosseTaskId: null,
  tosseTaskTitle: null,
  tosseTaskStatus: null,
  claudeAccountId: null,
  cleanOutput: null,
  kind: "claude",
  ...over,
});

const file = (path: string, xy: string, untracked = false): GitFileEntry => ({
  path,
  orig_path: null,
  index_status: untracked ? "." : xy[0],
  worktree_status: untracked ? "?" : xy[1],
  staged: !untracked && xy[0] !== ".",
  unstaged: untracked || xy[1] !== ".",
  untracked,
});

const STATUS = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: "main",
  head: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  upstream_gone: false,
  unborn: false,
  files: [file("a.ts", "M."), file("b.ts", ".M"), file("notes.txt", "", true)],
  ...over,
});

const ok = (data: GitStatus) => ({ status: "ok" as const, data });
const fail = (error: string) => ({ status: "error" as const, error });
const CMD = "git --no-optional-locks status --porcelain=v2 --branch -z: ";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSidePanelLayout.getState().setCollapsed("git", false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  useEditorStore.getState().setGitOpen(false);
  useGitViewStore.getState().clearAll();
  useConversationStore.getState().dropSession("c1");
});

/** Let a query settle and its notification (a real `setTimeout(0)`) reach React. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

function mount(
  c: Conversation,
  { repoPath = "/tmp/r1", machineId = null as string | null, machines = [] as Machine[] } = {},
) {
  useConversationsStore.setState({
    conversations: [c],
    repos: [{ id: "r1", path: repoPath, addedAt: 1, machineId }],
    machines,
  });
  render(c);
}

function render(c: Conversation) {
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(GitStatusWidget, { conv: c })),
    );
  });
}

const text = () => container.textContent ?? "";
/** The header's capsule reading. */
const meta = () => container.querySelector("section .wf-mono")?.textContent ?? null;
/** The four counters' figures, in order. */
const figures = () =>
  [...container.querySelectorAll("[data-tone]")].map((v) => ({
    text: v.textContent,
    tone: v.getAttribute("data-tone"),
  }));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;

describe("GitStatusWidget — what reaches the screen", () => {
  it("one status read: branch, sync pill, four counters and the count in the header", async () => {
    const read = vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    mount(conv());
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/tmp/r1");
    expect(meta()).toBe("3");
    expect(text()).toContain("main");
    expect(text()).toContain("↑2 ↓1");
    expect(figures()).toEqual([
      { text: "1", tone: "some" },
      { text: "1", tone: "some" },
      { text: "1", tone: "some" },
      { text: "0", tone: "zero" }, // a real 0, dim — and git said it
    ]);
  });

  it("unknown reads dashes everywhere, never a fake 0", async () => {
    vi.spyOn(commands, "gitStatus").mockReturnValue(new Promise(() => {}));
    mount(conv());
    await settle();
    expect(meta()).toBe("—");
    expect(figures().map((f) => f.text)).toEqual(["—", "—", "—", "—"]);
    expect(figures().every((f) => f.tone === "unknown")).toBe(true);
    expect(text()).not.toContain("0");
    expect(text()).not.toContain("clean");
  });

  it("a clean tree says clean, with real zeros", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS({ files: [], ahead: 0, behind: 0 })));
    mount(conv());
    await settle();
    expect(meta()).toBe("clean");
    expect(text()).toContain("in sync");
    expect(figures().every((f) => f.text === "0" && f.tone === "zero")).toBe(true);
  });

  it("a conflict turns its counter red and stays out of Staged / Modified", async () => {
    const conflict: GitFileEntry = { ...file("c.ts", "UU"), staged: true, unstaged: true };
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS({ files: [conflict] })));
    mount(conv());
    await settle();
    expect(figures()).toEqual([
      { text: "0", tone: "zero" },
      { text: "0", tone: "zero" },
      { text: "0", tone: "zero" },
      { text: "1", tone: "alarm" },
    ]);
  });

  it("no upstream is said, not drawn as a fake in-sync", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS({ upstream: null, ahead: 0, behind: 0 })));
    mount(conv());
    await settle();
    expect(text()).toContain("no upstream");
    expect(text()).not.toContain("in sync");
  });

  it("a detached HEAD reads its short oid, tagged, with no 'no upstream' pill", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS({ branch: null, upstream: null })));
    mount(conv());
    await settle();
    expect(text()).toContain("a1b2c3d");
    expect(text()).toContain("detached");
    expect(text()).not.toContain("no upstream");
  });

  it("an unborn branch keeps its name and says it has no commits", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(
      ok(STATUS({ head: null, unborn: true, upstream: null, files: [] })),
    );
    mount(conv());
    await settle();
    expect(text()).toContain("main");
    expect(text()).toContain("no commits");
  });

  it("a gone upstream says so, never a fake in-sync", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(
      ok(STATUS({ upstream: "origin/feat", upstream_gone: true, ahead: 0, behind: 0 })),
    );
    mount(conv());
    await settle();
    expect(text()).toContain("upstream gone");
    expect(text()).not.toContain("in sync");
    expect(container.querySelector("[data-warn]")?.textContent).toBe("upstream gone");
  });
});

describe("GitStatusWidget — nothing read when there is nothing to read here", () => {
  it("a remote repository mounts no query and says where it lives", async () => {
    const read = vi.spyOn(commands, "gitStatus");
    mount(conv({ cwd: "/srv/r1" }), {
      repoPath: "/srv/r1",
      machineId: "m1",
      machines: [{ id: "m1", label: "Build box" } as Machine],
    });
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(meta()).toBe("—");
    expect(text()).toContain("Lives on Build box — git status reads this Mac only.");
    expect(button("Changes")).toBeNull();
  });

  it("a remote repository of an unknown (or unnamed) server still says it is remote", async () => {
    mount(conv({ cwd: "/srv/r1" }), {
      repoPath: "/srv/r1",
      machineId: "m1",
      machines: [{ id: "m1", label: "  " } as Machine],
    });
    await settle();
    expect(text()).toContain("Lives on a remote server");
  });

  it("a relative cwd (the default project) renders nothing and reads nothing", async () => {
    const read = vi.spyOn(commands, "gitStatus");
    mount(conv({ cwd: "." }), { repoPath: "." });
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("a folder that is not a git repository renders nothing — an ordinary folder, not a failure", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(
      fail(`${CMD}fatal: not a git repository (or any of the parent directories): .git`),
    );
    mount(conv());
    await settle();
    expect(container.innerHTML).toBe("");
  });
});

describe("GitStatusWidget — failures", () => {
  it("an error on a REFETCH wins over the last good counts", async () => {
    const read = vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    mount(conv());
    await settle();
    expect(meta()).toBe("3");
    read.mockResolvedValue(fail(`${CMD}fatal: cannot change to '/tmp/r1': No such file or directory`));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["git", "/tmp/r1", "status"] });
    });
    await settle();
    expect(text()).toContain("This folder no longer exists.");
    expect(meta()).toBe("—");
    expect(figures()).toEqual([]);
    expect(button("Changes")).toBeNull();
  });

  it("an unexpected failure is red, in git's own words, with the full text on hover", async () => {
    const raw = `${CMD}fatal: detected dubious ownership in repository at '/tmp/r1'`;
    vi.spyOn(commands, "gitStatus").mockResolvedValue(fail(raw));
    mount(conv());
    await settle();
    const line = [...container.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("Couldn't read the git status"),
    );
    expect(line?.textContent).toBe(
      "Couldn't read the git status: detected dubious ownership in repository at '/tmp/r1'",
    );
    expect(line?.getAttribute("title")).toBe(raw);
  });

  it("a broken worktree link is a failure on screen, not a folder that silently vanishes", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(
      fail(`${CMD}fatal: not a git repository: /tmp/r1/.git/worktrees/x`),
    );
    mount(conv());
    await settle();
    expect(text()).toContain("Couldn't read the git status: not a git repository: /tmp/r1/.git/worktrees/x");
  });

  it("a missing git says so, quietly", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(
      fail("could not launch git: No such file or directory (os error 2)"),
    );
    mount(conv());
    await settle();
    expect(text()).toContain("git is not installed on this Mac.");
    expect(meta()).toBe("—");
    expect(button("Changes")).toBeNull();
  });

  it("a folder macOS keeps us out of is not called gone", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(
      fail(`${CMD}fatal: cannot change to '/tmp/r1': Operation not permitted`),
    );
    mount(conv());
    await settle();
    expect(text()).toContain("Privacy & Security");
    expect(text()).not.toContain("no longer exists");
  });
});

describe("GitStatusWidget — cost when folded", () => {
  it("folded: the header keeps its reading, the body and its fs listener are gone", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    const listen = vi.spyOn(events.fsChangeEvent, "listen");
    useSidePanelLayout.getState().setCollapsed("git", true);
    mount(conv());
    await settle();
    expect(meta()).toBe("3");
    expect(figures()).toEqual([]);
    expect(listen).not.toHaveBeenCalled();
    // Unfolding brings the body — and its one fs listener — back.
    act(() => useSidePanelLayout.getState().setCollapsed("git", false));
    await settle();
    expect(figures()).toHaveLength(4);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("follows the session's cwd, and ignores the state events that leave it alone", async () => {
    const read = vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    const store = useConversationStore.getState();
    store.ensureSession("c1");
    const base = useConversationStore.getState().sessions.c1!.state;
    act(() => store.applyState("c1", { ...base, busy: true, cwd: "/tmp/r1/sub" }));
    useConversationsStore.setState({
      conversations: [conv()],
      repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1, machineId: null }],
      machines: [],
    });
    let commits = 0;
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(Profiler, { id: "git", onRender: () => void commits++ }, createElement(GitStatusWidget, { conv: conv() })),
        ),
      );
    });
    await settle();
    expect(read).toHaveBeenCalledWith("/tmp/r1/sub");
    const settled = commits;
    // A running turn re-emits its state all the time (context meter…): same cwd, no re-render.
    act(() =>
      store.applyState("c1", { ...base, busy: true, cwd: "/tmp/r1/sub", context_tokens: 1234 }),
    );
    await settle();
    expect(commits).toBe(settled);
    // The cwd moving is another folder: another read.
    act(() => store.applyState("c1", { ...base, busy: true, cwd: "/tmp/r1/other" }));
    await settle();
    expect(read).toHaveBeenLastCalledWith("/tmp/r1/other");
  });

  it("the roll is off when panel animations are", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    /** The motion gate the counters' roll hangs off (its CSS is scoped under it). */
    const gate = () => container.querySelector("[data-tone]")?.closest("[data-motion]") ?? null;
    mount(conv());
    await settle();
    expect(gate()).not.toBeNull();
    act(() => useDisplay.getState().set({ panelAnimations: false }));
    try {
      await settle();
      expect(gate()).toBeNull();
    } finally {
      useDisplay.getState().set({ panelAnimations: true });
    }
  });

  it("with the Git workspace open on the same folder: one listener, one read per fs burst", async () => {
    const read = vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    const listen = vi.spyOn(events.fsChangeEvent, "listen");
    // Another view refreshing the same folder on fs changes (the Git workspace does this).
    function OtherView() {
      useGitAutoRefresh("/tmp/r1");
      return null;
    }
    useConversationsStore.setState({
      conversations: [conv()],
      repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1, machineId: null }],
      machines: [],
    });
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(GitStatusWidget, { conv: conv() }),
          createElement(OtherView),
        ),
      );
    });
    await settle();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    const emit = (paths: string[]) =>
      (events.fsChangeEvent as unknown as { emit: (p: { paths: string[] }) => void }).emit({ paths });
    emit(["/tmp/other/x.ts"]); // another folder: ignored
    emit(["/tmp/r1/a.ts"]);
    emit(["/tmp/r1/b.ts"]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, GIT_FS_REFRESH_THROTTLE_MS + 100));
    });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("GitStatusWidget — the Changes action and the counters' roll", () => {
  it("Changes opens THIS conversation's Git view on its Changes tab", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    mount(conv());
    await settle();
    act(() => button("Changes")!.click());
    expect(useEditorStore.getState().gitOpen).toBe(true);
    expect(useGitViewStore.getState().byConv.c1?.tab).toBe("changes");
  });

  it("a known count that changes rolls in; the first reading does not", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    mount(conv());
    await settle();
    expect(container.querySelector("[data-roll]")).toBeNull();
    act(() => {
      qc.setQueryData(
        ["git", "/tmp/r1", "status"],
        STATUS({ files: [file("a.ts", "M."), file("b.ts", ".M"), file("d.ts", ".M")] }),
      );
    });
    await settle();
    const rolled = [...container.querySelectorAll("[data-roll]")].map((f) => [
      f.textContent,
      f.getAttribute("data-roll"),
    ]);
    // Modified 1→2 grew, Untracked 1→0 shrank; Staged and Conflicts did not move.
    expect(rolled).toEqual([
      ["2", "up"],
      ["0", "down"],
    ]);
  });

  it("a cwd move is another tree, not a change: its counts do not roll", async () => {
    vi.spyOn(commands, "gitStatus").mockResolvedValue(ok(STATUS()));
    const wt = "/tmp/r1/.claude/worktrees/x";
    // The worktree's answer is already cached, so no unknown step sits between the two trees.
    qc.setQueryData(["git", wt, "status"], STATUS({ files: [] }));
    mount(conv());
    await settle();
    render(conv({ liveCwd: wt }));
    await settle();
    expect(meta()).toBe("clean");
    expect(container.querySelector("[data-roll]")).toBeNull();
  });
});
