// A background task kept running after its REMOTE session ended on this Mac (another client took
// the conversation over, this Mac let go, the link failed for good): its Stop is still offered,
// so it must be honoured — by reattaching (a spawn that re-joins the server-side conversation,
// no model turn) and stopping it there, never by an error telling the user to send a message.
// A LOCAL session that is gone took its tasks with it: they are settled at once, nothing spawned.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const ok = <T>(data: T) => ({ status: "ok" as const, data });
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  // Every command the spawn path may touch answers ok; the two under test are read back.
  const commands = new Proxy(fns, {
    get: (target, key: string) => (target[key] ??= vi.fn(async () => ok(null))),
  });
  return { ok, fns, commands };
});

vi.mock("./client", () => ({ commands: mocks.commands, events: {} }));

import type { BackgroundTask } from "./client";
import { stopBackgroundTask } from "./useCommands";
import { useBackgroundTasksStore } from "../store/backgroundTasksStore";
import { useConversationsStore } from "../store/conversationsStore";

const task = (id: string): BackgroundTask => ({
  task_id: id,
  kind: "bash",
  tool_use_id: "toolu_b",
  label: "dev server",
  command: "pnpm dev",
  subagent_type: null,
  model: null,
  agent_id: null,
  status: "running",
  progress: null,
  tokens: null,
  tool_uses: null,
  duration_ms: null,
  summary: null,
  output_file: null,
  woken_by: null,
  backgrounded: true,
  ambient: false,
  owned_by_subagent: false,
  time_limit_ms: null,
  deadline_at_ms: null,
  stop_cause: null,
});

function seed(machineId: string | null) {
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [{ id: "r1", path: "/srv/app", machineId }] as never,
    conversations: [
      { id: "c1", repoId: "r1", cwd: "/srv/app", name: "remote", kind: "claude", sessionId: "sess-1", handle: null },
    ] as never,
  });
  useBackgroundTasksStore.getState().clear();
  useBackgroundTasksStore.getState().applyTask("c1", task("b1"));
}

beforeEach(() => {
  for (const fn of Object.values(mocks.fns)) fn.mockClear();
  mocks.commands.spawnSession.mockResolvedValue(mocks.ok("session-7"));
});

describe("stopping a background task with no live session", () => {
  it("on a server: reattaches, then stops it there", async () => {
    seed("m1");
    await stopBackgroundTask("c1", "b1");
    expect(mocks.fns.spawnSession).toHaveBeenCalledTimes(1);
    expect(mocks.fns.spawnSession.mock.calls[0][6]).toMatchObject({ machineId: "m1", conversationId: "c1" });
    expect(mocks.fns.stopTask).toHaveBeenCalledWith("session-7", "b1");
    // Left to the stop's own end event: the task is not claimed stopped before the server says so.
    expect(useBackgroundTasksStore.getState().sessions["c1"]["b1"].status).toBe("running");
  });

  it("on this Mac: the process took the task with it — settled, nothing spawned", async () => {
    seed(null);
    await stopBackgroundTask("c1", "b1");
    expect(mocks.commands.spawnSession).not.toHaveBeenCalled();
    expect(mocks.commands.stopTask).not.toHaveBeenCalled();
    expect(useBackgroundTasksStore.getState().sessions["c1"]["b1"].status).toBe("stopped");
  });

  it("with a live session: stops it on that session", async () => {
    seed("m1");
    useConversationsStore.setState((s) => ({
      conversations: s.conversations.map((c) => ({ ...c, handle: "session-3" })),
    }));
    await stopBackgroundTask("c1", "b1");
    expect(mocks.commands.spawnSession).not.toHaveBeenCalled();
    expect(mocks.fns.stopTask).toHaveBeenCalledWith("session-3", "b1");
  });
});
