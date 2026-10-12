// A REMOTE conversation's reattach replay, end to end through the global event router: the
// core flags the session `replaying` from its `fd_attach` to the replay's end and marks every
// item of the replay (`replay: true`). The router must apply those items as HYDRATION (no
// tool clock, no ~0 ms chip), bump no recency, and arm no notification — neither during the
// replay nor on the edge that ends it, where the core lands the resynced turn state.
// Same createElement + react-dom/client harness as the other render tests; every IPC call is
// a stub, every event listener is captured so the test can fire events itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listeners: {} as Record<string, (e: { payload: unknown }) => void>,
  calls: {} as Record<string, ReturnType<typeof import("vitest").vi.fn>>,
}));

vi.mock("./client", () => ({
  // Any command resolves `ok` (persisting a reminder, publishing a control event, …).
  commands: new Proxy(
    {},
    {
      get: (_t, name: string) =>
        (ipc.calls[name] ??= vi.fn(() => Promise.resolve({ status: "ok", data: null }))),
    },
  ),
  // Every event's `listen` hands its callback to the test.
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

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationItem, SessionStatePayload } from "./client";
import { useGlobalSessionEvents } from "./useGlobalSessionEvents";
import { useConversationsStore, type Conversation } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import { useBackgroundTasksStore } from "../store/backgroundTasksStore";
import { armedAgentNotificationKind, cancelAgentNotification } from "../notifications/notify";

const conv: Conversation = {
  id: "c1",
  name: "remote work",
  repoId: "r1",
  cwd: "/srv/app",
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

const toolTurn: ConversationItem[] = [
  { kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null },
  {
    kind: "assistant_message",
    id: "m1",
    parent_tool_use_id: null,
    turn_id: null,
    blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
  },
  { kind: "tool_result", tool_use_id: "t1", content: "ok", is_error: false, parent_tool_use_id: null },
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

let container: HTMLDivElement;
let root: Root;

function Host() {
  useGlobalSessionEvents();
  return null;
}

beforeEach(async () => {
  // jsdom may lack a frame clock: the router's coalescing then runs on a plain timer.
  if (typeof globalThis.requestAnimationFrame !== "function") {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  }
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/srv/app", addedAt: 1 }],
    conversations: [conv],
    activeId: null,
  });
  useConversationStore.setState({ sessions: {} });
  useBackgroundTasksStore.getState().clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient();
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Host)));
  });
  // Let the router's `listen().then(...)` registrations settle.
  await act(async () => {});
});

afterEach(() => {
  cancelAgentNotification("c1");
  act(() => root.unmount());
  container.remove();
});

describe("a remote reattach replay through the event router", () => {
  it("applies the replay as history: no tool clock, no recency bump, no 'done' armed", () => {
    emitState({ busy: true });
    // `fd_attach`: the core holds `busy` and says `replaying`.
    emitState({ busy: true, replaying: true });
    for (const item of toolTurn) emitItem(item, true);
    // The replay's end: the resync says the turn is over — a resync, not a completion.
    emitState({ busy: false, replaying: false });

    const entry = useConversationStore.getState().sessions["c1"];
    expect(entry.turns["m1"].blocks).toHaveLength(1);
    expect(entry.toolResults["t1"]).toBeDefined();
    expect(entry.timeline.filter((e) => e.kind === "turn_result")).toHaveLength(1);
    expect(entry.toolStartedAt["t1"]).toBeUndefined();
    expect(entry.toolDurations["t1"]).toBeUndefined();
    expect(useConversationsStore.getState().conversations[0].lastActivityAt).toBe(1);
    expect(armedAgentNotificationKind("c1")).toBeNull();
  });

  it("re-delivering the same replay changes nothing on screen", () => {
    emitState({ replaying: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    const before = useConversationStore.getState().sessions["c1"];
    emitState({ replaying: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    const after = useConversationStore.getState().sessions["c1"];
    expect(after.timeline).toEqual(before.timeline);
    expect(after.turns["m1"].blocks).toEqual(before.turns["m1"].blocks);
  });

  it("a task first seen during the replay gets no 'working since' stamp", () => {
    emitState({ replaying: true });
    fire("sessionTaskEvent", {
      session: "session-1",
      task: {
        task_id: "b1",
        kind: "bash",
        tool_use_id: "t1",
        label: "dev server",
        command: "npm run dev",
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
      },
    });
    expect(useBackgroundTasksStore.getState().firstSeen["c1"]["b1"]).toBeNull();
  });

  it("the live path is unchanged: a live turn stamps its tool clock and bumps recency", () => {
    emitState({ busy: true });
    for (const item of toolTurn) emitItem(item, false);
    const entry = useConversationStore.getState().sessions["c1"];
    expect(entry.toolStartedAt["t1"]).toBeTypeOf("number");
    expect(useConversationsStore.getState().conversations[0].lastActivityAt).toBeGreaterThan(1);
  });
});
