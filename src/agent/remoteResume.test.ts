// At launch (and when the Mac comes back) a conversation that kept working on its server is put
// back: its server is asked what each conversation is doing, and the ones at work — or whose
// stream was on — are re-attached, their history read from the server FIRST so the attach's
// replay merges into it. One whose work ended while the Mac was away turns "review".
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const ok = <T>(data: T) => ({ status: "ok" as const, data });
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  const calls: string[] = [];
  // Every command the spawn path may touch answers ok; the ones under test are read back.
  const commands = new Proxy(fns, {
    get: (target, key: string) => (target[key] ??= vi.fn(async () => ok(null))),
  });
  return { ok, fns, commands, calls };
});

vi.mock("../ipc/client", () => ({ commands: mocks.commands, events: {} }));

import { resumeRemoteConversations } from "./remoteResume";
import { useConversationsStore } from "../store/conversationsStore";
import { clearAllRemoteStreams, markRemoteStream, remoteStreamMarks } from "../store/remoteStreams";

const EMPTY_CONTEXT = { context_tokens: null, context_window: null, context_usage: null };

function seed() {
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [
      { id: "r1", path: "/srv/app", machineId: "m1" },
      { id: "r2", path: "/Users/me/app", machineId: null },
    ] as never,
    conversations: [
      { id: "busy", repoId: "r1", cwd: "/srv/app", name: "busy", kind: "claude", sessionId: "s1", handle: null, pendingReminder: null },
      { id: "done", repoId: "r1", cwd: "/srv/app", name: "done", kind: "claude", sessionId: "s2", handle: null, pendingReminder: null },
      { id: "quiet", repoId: "r1", cwd: "/srv/app", name: "quiet", kind: "claude", sessionId: "s3", handle: null, pendingReminder: null },
      { id: "local", repoId: "r2", cwd: "/Users/me/app", name: "local", kind: "claude", sessionId: "s4", handle: null, pendingReminder: null },
    ] as never,
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks.fns)) fn.mockReset();
  mocks.calls.length = 0;
  clearAllRemoteStreams();
  let n = 0;
  mocks.commands.spawnSession.mockImplementation(async (...args: unknown[]) => {
    const flags = args[6] as { conversationId: string };
    mocks.calls.push(`spawn:${flags.conversationId}`);
    return mocks.ok(`session-${++n}`);
  });
  mocks.commands.loadConversationHistory.mockImplementation(async (convId: string) => {
    mocks.calls.push(`history:${convId}`);
    return mocks.ok({ items: [], context: EMPTY_CONTEXT });
  });
  mocks.commands.remoteConversationStates.mockResolvedValue(
    mocks.ok([
      { conversation_id: "busy", running: true, busy: true, pending: 0, background_tasks: 0, at_work: true },
      { conversation_id: "done", running: true, busy: false, pending: 0, background_tasks: 0, at_work: false },
      { conversation_id: "quiet", running: true, busy: false, pending: 0, background_tasks: 0, at_work: false },
    ]),
  );
  seed();
});

const conv = (id: string) => useConversationsStore.getState().conversations.find((c) => c.id === id)!;

describe("resuming remote conversations", () => {
  it("asks each server once and re-attaches the conversations at work or whose stream was on", async () => {
    markRemoteStream("done", true); // it was working when the app quit
    await resumeRemoteConversations();
    expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(1);
    expect(mocks.fns.remoteConversationStates).toHaveBeenCalledWith("m1");
    // The busy one and the one whose stream was on; never the idle one nobody watched, never local.
    expect(mocks.calls.filter((c) => c.startsWith("spawn:")).sort()).toEqual(["spawn:busy", "spawn:done"]);
    for (const id of ["busy", "done"]) {
      // History from the server first: the replay merges into it.
      expect(mocks.calls.indexOf(`history:${id}`)).toBeLessThan(mocks.calls.indexOf(`spawn:${id}`));
      expect(conv(id).handle).toMatch(/^session-/);
    }
    expect(conv("quiet").handle).toBeNull();
    // Its work ended while the app was closed: there is something to review.
    expect(conv("done").pendingReminder).toBe("review");
    expect(conv("busy").pendingReminder).toBeNull();
  });

  it("decides nothing when the server cannot be asked", async () => {
    markRemoteStream("done", true);
    mocks.commands.remoteConversationStates.mockResolvedValue({ status: "error", error: "unreachable" });
    await resumeRemoteConversations();
    expect(mocks.fns.spawnSession).not.toHaveBeenCalled();
    expect(conv("done").pendingReminder).toBeNull();
    expect(remoteStreamMarks()).toEqual({ done: { atWork: true } });
  });

  it("keeps the marks of conversations the store does not hold (it may simply have failed to load)", async () => {
    markRemoteStream("not-loaded", true);
    markRemoteStream("local", false); // known, and on this Mac: nothing to put back
    useConversationsStore.setState({ conversations: [conv("local")] as never });
    await resumeRemoteConversations();
    expect(remoteStreamMarks()).toEqual({ "not-loaded": { atWork: true } });
  });

  it("forgets the mark of a conversation whose process is gone, and asks no server when all are live", async () => {
    markRemoteStream("quiet", false);
    mocks.commands.remoteConversationStates.mockResolvedValue(mocks.ok([]));
    await resumeRemoteConversations();
    expect(remoteStreamMarks()).toEqual({});
    expect(mocks.fns.spawnSession).not.toHaveBeenCalled();

    useConversationsStore.setState((s) => ({
      conversations: s.conversations.map((c) => ({ ...c, handle: c.repoId === "r1" ? "live" : null })),
    }));
    mocks.fns.remoteConversationStates.mockClear();
    await resumeRemoteConversations();
    expect(mocks.fns.remoteConversationStates).not.toHaveBeenCalled();
  });
});
