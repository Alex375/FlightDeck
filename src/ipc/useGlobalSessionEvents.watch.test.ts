// Conversation watch & wait, wired through the REAL global event router: what the router tells
// `conversationWatch` on a session-state change. The watch module itself is spied (its own
// behaviour has its own tests); the point here is the wiring — the ended-before-unbind order,
// which state edges end a parked wait, and the reattach replay's missed turn.
// Same harness as useGlobalSessionEvents.replay.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listeners: {} as Record<string, (e: { payload: unknown }) => void>,
}));

vi.mock("./client", () => ({
  commands: new Proxy({}, { get: () => vi.fn(() => Promise.resolve({ status: "ok", data: null })) }),
  events: new Proxy(
    {},
    {
      get: (_t, name: string) => ({
        listen: (cb: (e: { payload: unknown }) => void) => {
          ipc.listeners[name] = cb;
          return Promise.resolve(() => {});
        },
      }),
    },
  ),
}));

const watch = vi.hoisted(() => ({
  waiting: false,
  handleAtEnded: undefined as string | null | undefined,
}));
vi.mock("../agent/conversationWatch", async (importOriginal) => {
  const real = await importOriginal<typeof import("../agent/conversationWatch")>();
  return {
    ...real,
    installConversationWatch: vi.fn(),
    isWaiting: vi.fn(() => watch.waiting),
    cancelWaitsOf: vi.fn(),
    publishWatchEvent: vi.fn(),
    publishSessionEnded: vi.fn(() => {
      // Read at call time: watchers must hear the ending BEFORE the handle is unbound.
      watch.handleAtEnded = useConversationsStore.getState().conversations[0]?.handle;
    }),
  };
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BackgroundTask, ConversationItem, SessionStatePayload } from "./client";
import { settledWatchEvent, useGlobalSessionEvents, waitAbandoned } from "./useGlobalSessionEvents";
import { useConversationsStore, type Conversation } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import { useBackgroundTasksStore } from "../store/backgroundTasksStore";
import { cancelAgentNotification, noteInterrupt } from "../notifications/notify";
import { cancelWaitsOf, publishSessionEnded, publishWatchEvent } from "../agent/conversationWatch";

const conv: Conversation = {
  id: "c1",
  name: "worker",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: null,
  handle: "session-1",
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
};

const state = (o: Partial<SessionStatePayload>): SessionStatePayload => ({
  busy: false,
  session_id: null,
  cwd: null,
  model: null,
  permission_mode: null,
  output_style: null,
  effort: null,
  ultracode: false,
  ultracode_available: null,
  activity: null,
  awaiting_permission: false,
  retry: null,
  link: null,
  ended: false,
  context_tokens: null,
  context_window: null,
  context_usage: null,
  rate_limit: null,
  ...o,
});

function fire(event: string, payload: unknown) {
  const cb = ipc.listeners[event];
  if (!cb) throw new Error(`no listener for ${event}`);
  act(() => cb({ payload }));
}
const emitState = (s: Partial<SessionStatePayload>) =>
  fire("sessionStateEvent", { session: "session-1", state: state(s) });
const emitItem = (item: ConversationItem, replay: boolean) =>
  fire("sessionMessageEvent", { session: "session-1", item, replay });

const bgTask: BackgroundTask = {
  task_id: "bg1",
  kind: "agent",
  tool_use_id: "tu-bg",
  label: "waits for another conversation",
  command: null,
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
};

let container: HTMLDivElement;
let root: Root;

function Host() {
  useGlobalSessionEvents();
  return null;
}

beforeEach(async () => {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  }
  vi.mocked(cancelWaitsOf).mockClear();
  vi.mocked(publishWatchEvent).mockClear();
  vi.mocked(publishSessionEnded).mockClear();
  watch.waiting = false;
  watch.handleAtEnded = undefined;
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
    conversations: [conv],
    activeId: null,
  });
  useConversationStore.setState({ sessions: {} });
  useBackgroundTasksStore.getState().clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Host)));
  });
  await act(async () => {});
});

afterEach(() => {
  cancelAgentNotification("c1");
  act(() => root.unmount());
  container.remove();
});

describe("the router tells conversationWatch", () => {
  it("an `ended` state, ONCE, with its reason — before the handle is unbound", () => {
    emitState({ busy: false });
    emitState({ ended: true, end_reason: "exited" });
    expect(publishSessionEnded).toHaveBeenCalledTimes(1);
    expect(publishSessionEnded).toHaveBeenCalledWith("c1", "exited");
    expect(watch.handleAtEnded).toBe("session-1");
    expect(useConversationsStore.getState().conversations[0].handle).toBeNull();
  });

  it("ends a parked wait when the turn ends with no background work, not on a permission prompt", () => {
    watch.waiting = true;
    emitState({ busy: true });
    emitState({ busy: false, awaiting_permission: true }); // a prompt also drops `busy`
    expect(cancelWaitsOf).not.toHaveBeenCalled();
    emitState({ busy: true });
    emitState({ busy: false });
    expect(cancelWaitsOf).toHaveBeenCalledWith("c1", "the waiting turn ended");
  });

  it("keeps a wait parked when the main turn ends while a background agent — its caller — runs", () => {
    watch.waiting = true;
    useBackgroundTasksStore.getState().applyTask("c1", bgTask);
    emitState({ busy: true });
    emitState({ busy: false });
    expect(cancelWaitsOf).not.toHaveBeenCalled();
  });

  it("publishes the turn a reattach replay carried, marked whileAway", () => {
    emitState({ busy: true });
    emitState({ busy: true, replaying: true });
    const items: ConversationItem[] = [
      { kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null },
      {
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        turn_id: null,
        blocks: [{ type: "text", text: "All tests pass." }],
      },
      {
        kind: "turn_result",
        subtype: "success",
        is_error: false,
        result: null,
        api_error_status: null,
        total_cost_usd: null,
        num_turns: 1,
        duration_ms: 1000,
        duration_api_ms: null,
        ttft_ms: null,
        usage: null,
        uuid: "r1",
      },
    ] as ConversationItem[];
    for (const it of items) emitItem(it, true);
    emitState({ busy: false, replaying: false });
    expect(publishWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "completed", conversationId: "c1", outcome: "success", whileAway: true }),
    );
  });
});

describe("waitAbandoned", () => {
  const busy = state({ busy: true });
  it("process gone → abandoned; prompt → not; turn end → only without background work, or on an interrupt", () => {
    expect(waitAbandoned(busy, state({ ended: true }), 3, false)).toBe(true);
    expect(waitAbandoned(busy, state({ awaiting_permission: true }), 0, false)).toBe(false);
    expect(waitAbandoned(busy, state({}), 0, false)).toBe(true);
    expect(waitAbandoned(busy, state({}), 1, false)).toBe(false);
    expect(waitAbandoned(busy, state({}), 1, true)).toBe(true);
    expect(waitAbandoned(state({}), state({}), 0, false)).toBe(false); // no edge
  });
});

describe("settledWatchEvent", () => {
  it("says a user-interrupted turn as such, never as a completion", () => {
    useConversationStore.getState().ensureSession("c1");
    noteInterrupt("c1");
    const ev = settledWatchEvent("c1", "done", useConversationStore.getState().sessions.c1);
    expect(ev).toMatchObject({ kind: "completed", outcome: "interrupted" });
  });
});
