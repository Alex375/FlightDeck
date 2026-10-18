import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      upsertConversation: vi.fn(() => ok()),
      upsertRepo: vi.fn(() => ok()),
      setActiveConversation: vi.fn(() => ok()),
      loadSessionHistory: vi.fn(() => ok([])),
      loadConversationHistory: vi.fn(() => ok({ items: [], context: { context_tokens: null } })),
      codexLoadHistory: vi.fn(() => ok([])),
      loadSessionContext: vi.fn(() => ok({ context_tokens: 0 })),
      loadSessionGoal: vi.fn(() => ok(null)),
      loadSessionUsage: vi.fn(() => ok(null)),
      deleteConversation: vi.fn(() => ok()),
      stopSession: vi.fn(() => ok()),
    },
  };
});

vi.mock("../ipc/useCommands", () => ({
  sendConversationMessage: vi.fn(() => Promise.resolve()),
}));

import { sendConversationMessage } from "../ipc/useCommands";
import {
  MAX_WATCH_DEPTH,
  cancelWaitsOf,
  hasUnsettledSend,
  installConversationWatch,
  nextEvent,
  noteMessageSent,
  notificationBody,
  publishSessionEnded,
  publishWatchEvent,
  resetConversationWatchForTests,
  takeEventSinceLastSend,
  turnDepth,
  unwatchConversation,
  useConversationWatchStore,
  watchConversation,
  watchesOf,
  type WatchEvent,
} from "./conversationWatch";
import { useConversationsStore, type Conversation } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import { useAppControlPrefs } from "../store/appControl";
import { useToasts } from "../store/toasts";
import { buildWatchNotificationEnvelope, parseAgentMessage } from "../features/conversation/agentMessage";
import type { Turn } from "../store/types";

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "Alpha",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 5,
  sessionId: null,
  handle: null,
  liveCwd: null,
  bypassAllowed: false,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "auto",
  pendingReminder: null,
  tosseTaskId: null,
  tosseTaskTitle: null,
  tosseTaskStatus: null,
  claudeAccountId: null,
  cleanOutput: null,
  kind: "claude",
  ...over,
});

function seed(...convs: Conversation[]) {
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
    conversations: convs,
    activeId: convs[0]?.id ?? null,
  });
}

let turnSeq = 0;
function pushUserTurn(convId: string, text: string) {
  useConversationStore.getState().ensureSession(convId);
  const s = useConversationStore.getState();
  const entry = s.sessions[convId];
  const id = `t${++turnSeq}`;
  const turn: Turn = {
    id,
    role: "user",
    status: "final",
    streamingText: text,
    streamingThinking: "",
    blocks: [],
    parentToolUseId: null,
    hasThinking: false,
  };
  useConversationStore.setState({
    sessions: {
      ...s.sessions,
      [convId]: {
        ...entry,
        timeline: [...entry.timeline, { kind: "turn" as const, id }],
        turns: { ...entry.turns, [id]: turn },
      },
    },
  });
}

const done = (conversationId: string, over: Partial<Extract<WatchEvent, { kind: "completed" }>> = {}): WatchEvent => ({
  kind: "completed",
  conversationId,
  outcome: "success",
  subtype: null,
  lastAssistantText: "All green.",
  openQuestion: false,
  ...over,
});

/** The notifications delivered so far, parsed: [recipient, envelope]. */
function delivered() {
  return vi.mocked(sendConversationMessage).mock.calls.map(([to, vars]) => ({
    to,
    msg: parseAgentMessage((vars as { text: string }).text),
    queued: (vars as { queued?: boolean }).queued,
  }));
}

/** Let the async delivery (history hydrate → send) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.mocked(sendConversationMessage).mockClear();
  resetConversationWatchForTests();
  useConversationStore.setState({ sessions: {} });
  useToasts.setState({ toasts: [] } as never);
  useAppControlPrefs.getState().set({ agentWatch: true });
  seed(conv({ id: "a", name: "Lead" }), conv({ id: "b", name: "Worker" }), conv({ id: "c", name: "Other" }));
});

describe("watch subscriptions", () => {
  it("a 'once' watch delivers ONE notification, attributed to the watched conversation, then ends", async () => {
    watchConversation("a", "b", "once");
    publishWatchEvent(done("b"));
    await flush();
    const out = delivered();
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe("a");
    expect(out[0].msg).toMatchObject({
      fromConversationId: "b",
      fromTitle: "Worker",
      watch: { event: "completed", depth: 1 },
    });
    expect(out[0].msg?.body).toContain('"Worker" finished its turn.');
    expect(out[0].msg?.body).toContain("All green.");
    expect(watchesOf("a")).toEqual([]);
    // A second event reaches no one.
    publishWatchEvent(done("b"));
    await flush();
    expect(delivered()).toHaveLength(1);
  });

  it("a 'persistent' watch delivers every event until unwatched", async () => {
    watchConversation("a", "b", "persistent");
    publishWatchEvent(done("b"));
    publishWatchEvent({ kind: "needs_attention", conversationId: "b", reason: "permission", tool: "Bash", prompt: "rm -rf build" });
    await flush();
    expect(delivered().map((d) => d.msg?.watch?.event)).toEqual(["completed", "needs_attention"]);
    expect(unwatchConversation("a", "b")).toBe(true);
    expect(unwatchConversation("a", "b")).toBe(false);
    publishWatchEvent(done("b"));
    await flush();
    expect(delivered()).toHaveLength(2);
  });

  it("injects into a watcher that is mid-turn, like any message", async () => {
    useConversationStore.getState().ensureSession("a");
    useConversationStore.getState().applyState("a", { ...useConversationStore.getState().sessions.a.state, busy: true });
    watchConversation("a", "b", "once");
    publishWatchEvent(done("b"));
    await flush();
    expect(delivered()[0].queued).toBe(true);
  });

  it("re-watching updates the mode instead of subscribing twice", () => {
    watchConversation("a", "b", "once");
    watchConversation("a", "b", "persistent");
    expect(watchesOf("a")).toEqual([{ watcherId: "a", targetId: "b", mode: "persistent" }]);
  });

  it("persists subscriptions (a server conversation keeps working while the app is closed)", () => {
    watchConversation("a", "b", "persistent");
    expect(JSON.parse(localStorage.getItem("tosse:convwatch") ?? "{}")).toEqual({
      subscriptions: [{ watcherId: "a", targetId: "b", mode: "persistent" }],
    });
  });

  it("a lost link keeps a 'once' watch alive — the real outcome is still to come", async () => {
    watchConversation("a", "b", "once");
    publishWatchEvent({ kind: "ended", conversationId: "b", reason: "link_failed" });
    await flush();
    expect(delivered()[0].msg?.body).toMatch(/may still be running on its server/);
    expect(delivered()[0].msg?.body).toMatch(/still watching it/);
    expect(watchesOf("a")).toHaveLength(1);
    publishWatchEvent(done("b"));
    await flush();
    expect(watchesOf("a")).toEqual([]);
  });

  it("this Mac letting go of a stream (detached) wakes no one", async () => {
    watchConversation("a", "b", "once");
    publishWatchEvent({ kind: "ended", conversationId: "b", reason: "detached" });
    await flush();
    expect(delivered()).toEqual([]);
    expect(watchesOf("a")).toHaveLength(1);
  });

  it("delivers nothing while the feature is off", async () => {
    watchConversation("a", "b", "persistent");
    useAppControlPrefs.setState({ agentWatch: false });
    publishWatchEvent(done("b"));
    await flush();
    expect(delivered()).toEqual([]);
  });

  it("a failed delivery is said to the human, never swallowed", async () => {
    vi.mocked(sendConversationMessage).mockRejectedValueOnce(new Error("spawn failed"));
    watchConversation("a", "b", "once");
    publishWatchEvent(done("b"));
    await flush();
    await flush();
    const toasts = useToasts.getState().toasts as Array<{ text?: string }>;
    expect(toasts.some((t) => t.text?.includes("Couldn't tell \"Lead\"") && t.text.includes("spawn failed"))).toBe(true);
  });
});

describe("loop guard", () => {
  it("reads the depth of a conversation's turn from its last prompt", () => {
    expect(turnDepth(undefined)).toBe(0);
    pushUserTurn("b", "do the thing");
    expect(turnDepth(useConversationStore.getState().sessions.b)).toBe(0);
    const sender = { conversationId: "a", title: "Lead", repo: null, backend: "claude" };
    pushUserTurn("b", buildWatchNotificationEnvelope(sender, { event: "completed", depth: 3 }, "x"));
    expect(turnDepth(useConversationStore.getState().sessions.b)).toBe(3);
    // A human speaking again resets the chain.
    pushUserTurn("b", "ok, carry on");
    expect(turnDepth(useConversationStore.getState().sessions.b)).toBe(0);
  });

  it("each notification is one deeper than the turn it reports on", async () => {
    const sender = { conversationId: "c", title: "Other", repo: null, backend: "claude" };
    pushUserTurn("b", buildWatchNotificationEnvelope(sender, { event: "completed", depth: 2 }, "x"));
    watchConversation("a", "b", "once");
    publishWatchEvent(done("b"));
    await flush();
    expect(delivered()[0].msg?.watch?.depth).toBe(3);
  });

  it(`holds back a notification past depth ${MAX_WATCH_DEPTH} and tells the human`, async () => {
    const sender = { conversationId: "a", title: "Lead", repo: null, backend: "claude" };
    pushUserTurn("b", buildWatchNotificationEnvelope(sender, { event: "completed", depth: MAX_WATCH_DEPTH }, "x"));
    watchConversation("a", "b", "persistent");
    publishWatchEvent(done("b"));
    await flush();
    expect(delivered()).toEqual([]);
    const toasts = useToasts.getState().toasts as Array<{ text?: string }>;
    expect(toasts.some((t) => t.text?.startsWith('Held back a notification to "Lead" about "Worker"'))).toBe(true);
  });
});

describe("waits", () => {
  it("a parked wait is answered by the next event — and its watcher gets no duplicate message", async () => {
    watchConversation("a", "b", "once");
    const waiting = nextEvent("a", "b", 60_000);
    publishWatchEvent(done("b"));
    await expect(waiting).resolves.toEqual({ kind: "event", event: done("b") });
    await flush();
    expect(delivered()).toEqual([]);
    // …and the 'once' it would have used is consumed all the same.
    expect(watchesOf("a")).toEqual([]);
  });

  it("an event after the caller's last message is returned at once, then consumed", () => {
    noteMessageSent("a", "b");
    expect(hasUnsettledSend("a", "b")).toBe(true);
    expect(takeEventSinceLastSend("a", "b")).toBeNull();
    publishWatchEvent(done("b"));
    expect(hasUnsettledSend("a", "b")).toBe(false);
    expect(takeEventSinceLastSend("a", "b")).toEqual(done("b"));
    expect(takeEventSinceLastSend("a", "b")).toBeNull();
  });

  it("an event from BEFORE the caller's message is not its answer", () => {
    publishWatchEvent(done("b"));
    noteMessageSent("a", "b");
    expect(takeEventSinceLastSend("a", "b")).toBeNull();
    expect(hasUnsettledSend("a", "b")).toBe(true);
  });

  it("times out explicitly, and can be cancelled", async () => {
    vi.useFakeTimers();
    try {
      const timedOut = nextEvent("a", "b", 1_000);
      vi.advanceTimersByTime(1_000);
      await expect(timedOut).resolves.toEqual({ kind: "timeout" });
      const cancelled = nextEvent("a", "b", 60_000);
      cancelWaitsOf("a", "the waiting turn ended");
      await expect(cancelled).resolves.toEqual({ kind: "cancelled", why: "the waiting turn ended" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("endings seen in the store", () => {
  beforeEach(() => installConversationWatch());

  it("a removed conversation reports 'removed' to its watchers, by its last name", async () => {
    watchConversation("a", "b", "persistent");
    useConversationsStore.setState((s) => ({ conversations: s.conversations.filter((c) => c.id !== "b") }));
    await flush();
    expect(delivered()).toHaveLength(1);
    expect(delivered()[0].msg).toMatchObject({ fromTitle: "Worker", watch: { event: "ended" } });
    expect(delivered()[0].msg?.body).toMatch(/removed from the conversation list[\s\S]*no longer watching/);
    expect(watchesOf("a")).toEqual([]);
  });

  it("a removed WATCHER loses its subscriptions and its waits end", async () => {
    watchConversation("a", "b", "persistent");
    const waiting = nextEvent("a", "b", 60_000);
    useConversationsStore.setState((s) => ({ conversations: s.conversations.filter((c) => c.id !== "a") }));
    await expect(waiting).resolves.toMatchObject({ kind: "cancelled" });
    expect(useConversationWatchStore.getState().subscriptions).toEqual([]);
  });

  it("a handle cleared without an `ended` state is a stop", async () => {
    seed(conv({ id: "a", name: "Lead" }), conv({ id: "b", name: "Worker", handle: "session-2" }));
    watchConversation("a", "b", "once");
    useConversationsStore.getState().setHandle("b", null);
    await flush();
    expect(delivered()[0].msg?.body).toMatch(/"Worker" was stopped/);
  });

  it("an ending the core reported is not reported again as a stop when the handle is cleared", async () => {
    seed(conv({ id: "a", name: "Lead" }), conv({ id: "b", name: "Worker", handle: "session-2" }));
    watchConversation("a", "b", "persistent");
    publishSessionEnded("b", "exited");
    useConversationsStore.getState().setHandle("b", null);
    await flush();
    expect(delivered()).toHaveLength(1);
    expect(delivered()[0].msg?.body).toMatch(/process ended unexpectedly/);
  });

  it("turning the feature off drops every subscription and ends every wait", async () => {
    watchConversation("a", "b", "persistent");
    const waiting = nextEvent("a", "b", 60_000);
    useAppControlPrefs.getState().set({ agentWatch: false });
    await expect(waiting).resolves.toEqual({ kind: "cancelled", why: "disabled" });
    expect(useConversationWatchStore.getState().subscriptions).toEqual([]);
  });
});

describe("notificationBody", () => {
  it("says how a turn ended, never a plain 'finished' for an error or an interrupt", () => {
    expect(notificationBody(done("b", { outcome: "error", subtype: "error_max_turns" }), "W", "once")).toMatch(
      /^"W"'s turn ended in error \(error_max_turns\)\./,
    );
    expect(notificationBody(done("b", { outcome: "interrupted" }), "W", "once")).toMatch(/interrupted by the user/);
    expect(notificationBody(done("b", { openQuestion: true }), "W", "once")).toMatch(/waiting for an answer/);
  });

  it("points to read_conversation and says whether the watch goes on", () => {
    const once = notificationBody(done("b"), "W", "once");
    expect(once).toContain('read_conversation (conversation_id: "b")');
    expect(once).toMatch(/one-time notification/);
    expect(notificationBody(done("b"), "W", "persistent")).toMatch(/until you call unwatch_conversation/);
  });

  it("names what a blocked conversation waits for", () => {
    const body = notificationBody(
      { kind: "needs_attention", conversationId: "b", reason: "permission", tool: "Bash", prompt: "Run tests" },
      "W",
      "once",
    );
    expect(body).toMatch(/a permission request \(Bash\)/);
    expect(body).toContain("> Run tests");
    expect(body).toMatch(/resumes only once the user answers/);
  });
});
