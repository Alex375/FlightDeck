// Settings → Claude Code → Helpers while the active conversation runs on a PAIRED SERVER. Its
// folder's path names a directory on the server: scanned here it would list — and offer to EDIT —
// an unrelated local clone's `.claude/agents`. The page shows THIS Mac's user-level helpers only
// (read from the home directory, like the global Extensions page), says so naming the server, and
// offers no project-level write. A local conversation's page is unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  const row = (name: string, origin: string, path: string) => ({
    name,
    description: `${name} helper`,
    effective_model: "sonnet",
    defined_model: null,
    effort: null,
    origin,
    path,
    built_in: false,
    shadows_built_in: false,
    needs_file_to_steer: false,
    overridden_by_force: false,
    configured_at_ms: null,
  });
  return {
    commands: {
      listSubagentRouting: vi.fn((repoPath: string) =>
        ok({
          // Read with the home dir as the "project", every user agent comes back twice.
          agents: [
            row("mine", "user", "/Users/me/.claude/agents/mine.md"),
            row("mine", "project", `${repoPath}/.claude/agents/mine.md`),
            row("clone-only", "project", `${repoPath}/.claude/agents/clone-only.md`),
          ],
          baseline: { model: null, forced_model: null, unreachable_builtins: [], error: null },
          user_agents_dir: "/Users/me/.claude/agents",
          project_agents_dir: `${repoPath}/.claude/agents`,
          project_dir_ignored: true,
          repo_is_worktree: false,
        }),
      ),
      subagentSpend: vi.fn(() => ok({ buckets: [], warnings: [], files_unreadable: 0 })),
      setSubagentModel: vi.fn(() => ok()),
      setSubagentBaseline: vi.fn(() => ok()),
    },
  };
});
vi.mock("../../../ipc/client", () => ipc);
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/Users/me") }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConversationsStore } from "../../../store/conversationsStore";
import { ClaudeCodeHelpers } from "./ClaudeCodeSection";

let container: HTMLDivElement;
let root: Root;

function mountFor(activeId: string) {
  useConversationsStore.setState({ activeId });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(ClaudeCodeHelpers),
      ),
    );
  });
}
const text = () => container.textContent ?? "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Base" }] as never,
    repos: [
      { id: "r-remote", path: "/srv/app", addedAt: 1, machineId: "m1" },
      { id: "r-local", path: "/Users/me/app", addedAt: 1, machineId: null },
    ],
    conversations: [
      { id: "c-remote", repoId: "r-remote", kind: "claude", name: "remote" },
      { id: "c-local", repoId: "r-local", kind: "claude", name: "local" },
    ] as never,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Claude Code → Helpers with a remote conversation active", () => {
  it("says it shows this Mac's config, reads only the home dir, and lists no project-level helper", async () => {
    mountFor("c-remote");
    await vi.waitFor(() => expect(text()).toContain("mine"));
    expect(text()).toContain("This conversation runs on Base");
    expect(text()).toContain("this Mac's Claude configuration");
    // Never the server folder's path, read on this Mac.
    expect(ipc.commands.listSubagentRouting).toHaveBeenCalledWith("/Users/me");
    expect(ipc.commands.listSubagentRouting).not.toHaveBeenCalledWith("/srv/app");
    // The user agent once (its project-scope duplicate dropped), the clone's own not at all.
    expect(text().match(/mine helper/g)).toHaveLength(1);
    expect(text()).not.toContain("clone-only");
    // Project-folder warnings belong to a project this page doesn't show.
    expect(text()).not.toContain("git setup ignores");
    // The spend table says what it doesn't count.
    expect(text()).toContain("conversations on Base is not included");
  });

  it("a local conversation's page is unchanged: its folder, its project helpers", async () => {
    mountFor("c-local");
    await vi.waitFor(() => expect(text()).toContain("clone-only"));
    expect(ipc.commands.listSubagentRouting).toHaveBeenCalledWith("/Users/me/app");
    expect(text()).not.toContain("runs on Base");
  });
});
