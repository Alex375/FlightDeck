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

import { awayWatchEvents, resetRemoteResumeForTests, resumeRemoteConversations } from "./remoteResume";
import { loadConversationHistory, useConversationsStore } from "../store/conversationsStore";
import { clearAllRemoteStreams, markRemoteStream, remoteStreamMarks } from "../store/remoteStreams";
import { REACHED, useMachineHealthStore } from "../store/machineHealth";
import { useConversationStore } from "../store/conversationStore";
import { useAppErrors } from "../store/appErrors";

const EMPTY_CONTEXT = { context_tokens: null, context_window: null, context_usage: null };

/** A server's status answer: its conversations, from a daemon with `caps`. */
const states = (conversations: object[], caps: string[] = []) =>
  mocks.ok({ daemon_caps: caps, conversations });

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
  resetRemoteResumeForTests();
  useMachineHealthStore.setState({ byMachine: {}, probing: {} });
  let n = 0;
  mocks.commands.spawnSession.mockImplementation(async (...args: unknown[]) => {
    const flags = args[6] as { conversationId: string; existingOnly?: boolean };
    mocks.calls.push(`spawn:${flags.conversationId}${flags.existingOnly ? ":existing-only" : ""}`);
    return mocks.ok(`session-${++n}`);
  });
  // Removing a server conversation stops (and archives) it on its server: nothing to report.
  mocks.commands.stopRemoteConversations.mockResolvedValue(mocks.ok({ stopped: [], not_archived: [] }));
  mocks.commands.loadConversationHistory.mockImplementation(async (convId: string) => {
    mocks.calls.push(`history:${convId}`);
    return mocks.ok({ items: [], context: EMPTY_CONTEXT });
  });
  mocks.commands.remoteConversationStates.mockResolvedValue(
    states([
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

  it("follows a session that moved on the server before reading history or attaching", async () => {
    // A `/clear` sent from the phone while the Mac was away: the daemon's conversation runs a new
    // session — this Mac's copy is stale, and resuming it would show (and run) the old one.
    // (`quiet`: a conversation whose history no earlier test loaded — loads are cached per run.)
    mocks.commands.remoteConversationStates.mockResolvedValue(
      states([
        { conversation_id: "quiet", running: true, busy: true, pending: 0, background_tasks: 0, at_work: true, session_id: "s3-moved" },
        { conversation_id: "done", running: true, busy: false, pending: 0, background_tasks: 0, at_work: false, session_id: "s2" },
      ]),
    );
    await resumeRemoteConversations();
    expect(conv("quiet").sessionId).toBe("s3-moved");
    expect(mocks.fns.loadConversationHistory).toHaveBeenCalledWith("quiet", "s3-moved");
    expect(mocks.fns.upsertConversation).toHaveBeenCalledWith(expect.objectContaining({ id: "quiet", session_id: "s3-moved" }));
    expect(mocks.calls.indexOf("history:quiet")).toBeLessThan(mocks.calls.indexOf("spawn:quiet"));
    expect(conv("done").sessionId).toBe("s2");
  });

  it("attaches join-only when the server's running daemon offers it, never starting a claude", async () => {
    // Its process may end (a stop from the phone) while its history is read: the attach must then
    // find nothing rather than cold-start it. Only when THAT daemon says it can.
    mocks.commands.remoteConversationStates.mockResolvedValue(
      states(
        [{ conversation_id: "busy", running: true, busy: true, pending: 0, background_tasks: 0, at_work: true }],
        ["set-title", "existing-only"],
      ),
    );
    await resumeRemoteConversations();
    expect(mocks.calls.filter((c) => c.startsWith("spawn:"))).toEqual(["spawn:busy:existing-only"]);

    // An older daemon (no such cap): the plain attach it understands.
    useConversationsStore.setState((s) => ({ conversations: s.conversations.map((c) => ({ ...c, handle: null })) }));
    mocks.calls.length = 0;
    mocks.commands.remoteConversationStates.mockResolvedValue(
      states([{ conversation_id: "busy", running: true, busy: true, pending: 0, background_tasks: 0, at_work: true }]),
    );
    await resumeRemoteConversations();
    expect(mocks.calls.filter((c) => c.startsWith("spawn:"))).toEqual(["spawn:busy"]);
  });

  it("says a conversation whose process died while at work was cut short, not finished", async () => {
    // A conversation of its own: history reads are remembered per run, and this one's is read below.
    useConversationsStore.setState((s) => ({
      conversations: [
        ...s.conversations,
        { id: "cut", repoId: "r1", cwd: "/srv/app", name: "cut", kind: "claude", sessionId: "s5", handle: null, pendingReminder: null },
      ] as never,
    }));
    markRemoteStream("cut", true); // it was working when the app quit
    mocks.commands.remoteConversationStates.mockResolvedValue(
      states([{ conversation_id: "busy", running: true, busy: true, pending: 0, background_tasks: 0, at_work: true }]),
    );
    await resumeRemoteConversations();
    expect(conv("cut").pendingReminder).toBe("error");
    expect(conv("cut").handle).toBeNull();
    const entry = useConversationStore.getState().sessions["cut"];
    const errors = Object.values(entry?.errors ?? {});
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Target");
    expect(errors[0].message).toContain("cut short");
    expect(remoteStreamMarks()).toEqual({});
    // Opening it reads its history from the server: the notice stays below it.
    mocks.commands.loadConversationHistory.mockResolvedValueOnce(
      mocks.ok({
        items: [{ kind: "assistant_message", id: "m1", parent_tool_use_id: null, turn_id: null, blocks: [{ type: "text", text: "Working on it" }] }],
        context: EMPTY_CONTEXT,
      }),
    );
    await loadConversationHistory("cut");
    const timeline = useConversationStore.getState().sessions["cut"].timeline;
    expect(timeline.map((e) => e.kind)).toEqual(["turn", "error"]);
  });

  it("decides nothing when the server cannot be asked", async () => {
    markRemoteStream("done", true);
    mocks.commands.remoteConversationStates.mockResolvedValue({ status: "error", error: "unreachable" });
    await resumeRemoteConversations();
    expect(mocks.fns.spawnSession).not.toHaveBeenCalled();
    expect(conv("done").pendingReminder).toBeNull();
    expect(remoteStreamMarks()).toEqual({ done: { atWork: true } });
  });

  it("retries a server whose status could not be read once it answers", async () => {
    // The Mac just woke: the tunnel to the server is not up yet when the pass runs.
    vi.useFakeTimers();
    try {
      mocks.commands.remoteConversationStates.mockResolvedValueOnce({ status: "error", error: "ssh command failed" });
      await resumeRemoteConversations();
      expect(mocks.fns.spawnSession).not.toHaveBeenCalled();
      // Nothing else would ask again: no `online` event (the Wi-Fi never dropped), no wake.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(2);
      expect(mocks.calls).toContain("spawn:busy");
      // It answered: no further retry.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks a server again as soon as the health probe sees it come back", async () => {
    mocks.commands.remoteConversationStates.mockResolvedValueOnce({ status: "error", error: "ssh command failed" });
    await resumeRemoteConversations();
    expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(1);
    const health = useMachineHealthStore.getState();
    health.recordReachability("m1", { reachable: false, reason: "timed out" });
    expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(1);
    // The ambient sweep (or "Check now") reaches it: no need to wait out the backoff.
    health.recordReachability("m1", REACHED);
    await vi.waitFor(() => expect(mocks.calls).toContain("spawn:busy"));
    expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(2);
    // A server that stays reachable is not re-asked on every sweep.
    health.recordReachability("m1", REACHED);
    await Promise.resolve();
    expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(2);
  });

  it("does not dial while this Mac has no network, and keeps the retry armed", async () => {
    vi.useFakeTimers();
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      mocks.commands.remoteConversationStates.mockResolvedValueOnce({ status: "error", error: "ssh command failed" });
      await resumeRemoteConversations();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(1);
      onLine.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(2);
      expect(mocks.calls).toContain("spawn:busy");
    } finally {
      onLine.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a trigger arriving during a failing pass runs one more pass instead of joining it", async () => {
    let fail!: () => void;
    mocks.commands.remoteConversationStates.mockImplementationOnce(
      () => new Promise((resolve) => (fail = () => resolve({ status: "error", error: "did not answer in time" }))),
    );
    const first = resumeRemoteConversations();
    await Promise.resolve();
    // The network comes back while that status read is still waiting.
    const second = resumeRemoteConversations();
    fail();
    await Promise.all([first, second]);
    expect(mocks.fns.remoteConversationStates).toHaveBeenCalledTimes(2);
    expect(mocks.calls).toContain("spawn:busy");
  });

  it("re-reads the server transcript of a conversation whose history was read earlier in this run", async () => {
    // Read hours ago (the user viewed it); it kept working from the phone since, past what the
    // daemon's ring still holds: only a fresh read covers what the replay no longer has.
    await loadConversationHistory("busy");
    mocks.calls.length = 0;
    await resumeRemoteConversations();
    expect(mocks.calls.filter((c) => c === "history:busy")).toHaveLength(1);
    expect(mocks.calls.indexOf("history:busy")).toBeLessThan(mocks.calls.indexOf("spawn:busy"));
  });

  it("does not read twice a history whose first read is still on its way", async () => {
    let land!: () => void;
    mocks.commands.loadConversationHistory.mockImplementationOnce(
      (convId: string) =>
        new Promise((resolve) => {
          mocks.calls.push(`history:${convId}`);
          land = () => resolve(mocks.ok({ items: [], context: EMPTY_CONTEXT }));
        }),
    );
    // Not yet read in this run (a conversation of its own: reads are remembered per run): the
    // user opens it as the launch pass starts.
    useConversationsStore.setState((s) => ({
      conversations: [
        ...s.conversations,
        { id: "opened", repoId: "r1", cwd: "/srv/app", name: "opened", kind: "claude", sessionId: "s9", handle: null, pendingReminder: null },
      ] as never,
    }));
    mocks.commands.remoteConversationStates.mockResolvedValueOnce(
      states([{ conversation_id: "opened", running: true, busy: true, pending: 0, background_tasks: 0, at_work: true }]),
    );
    const opened = loadConversationHistory("opened");
    markRemoteStream("opened", true);
    const pass = resumeRemoteConversations();
    await Promise.resolve();
    land();
    await Promise.all([opened, pass]);
    expect(mocks.calls.filter((c) => c === "history:opened")).toHaveLength(1);
    expect(mocks.calls).toContain("spawn:opened");
  });

  it("stops the session of a conversation removed while it was being re-attached, quietly", async () => {
    let land!: () => void;
    mocks.commands.spawnSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          mocks.calls.push("spawn:busy");
          land = () => resolve(mocks.ok("session-late"));
        }),
    );
    useAppErrors.setState({ errors: [] });
    const pass = resumeRemoteConversations();
    await vi.waitFor(() => expect(mocks.calls).toContain("spawn:busy"));
    useConversationsStore.getState().removeConversation("busy");
    land();
    await pass;
    expect(mocks.fns.stopSession).toHaveBeenCalledWith("session-late");
    expect(useAppErrors.getState().errors).toEqual([]);
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
    mocks.commands.remoteConversationStates.mockResolvedValue(states([]));
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

describe("awayWatchEvents — what a resume tells conversations watching these", () => {
  it("settled while away → completed (outcome unknown); process gone → ended; a takeover → nothing again", () => {
    const evs = awayWatchEvents(
      // `gone` was at work and its process is gone: cut short (`ended`), never a review.
      { attach: ["a"], review: ["a"], ended: ["gone"], forget: ["gone", "taken"] },
      { a: { atWork: true }, gone: { atWork: true }, taken: { atWork: false, replaced: true } },
    );
    expect(evs).toEqual([
      {
        kind: "completed",
        conversationId: "a",
        outcome: "unknown",
        subtype: null,
        lastAssistantText: null,
        openQuestion: false,
        whileAway: true,
      },
      { kind: "ended", conversationId: "gone", reason: "exited", whileAway: true },
    ]);
  });
});
