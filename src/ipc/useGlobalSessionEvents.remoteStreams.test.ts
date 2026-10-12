// A REMOTE conversation's live stream, through the global event router: what this Mac remembers
// of it for the next launch (stream on, at work or not — `store/remoteStreams`), and a first
// attach's whole-history replay merging into the history already read from the server.
// Same createElement + react-dom/client harness as useGlobalSessionEvents.replay.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listeners: {} as Record<string, (e: { payload: unknown }) => void>,
  calls: {} as Record<string, ReturnType<typeof import("vitest").vi.fn>>,
}));

vi.mock("./client", () => ({
  commands: new Proxy(
    {},
    {
      get: (_t, name: string) =>
        (ipc.calls[name] ??= vi.fn(() => Promise.resolve({ status: "ok", data: null }))),
    },
  ),
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
import type { ConversationItem, SessionEndReason, SessionStatePayload } from "./client";
import { useGlobalSessionEvents } from "./useGlobalSessionEvents";
import { useConversationsStore, type Conversation } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import { useBackgroundTasksStore } from "../store/backgroundTasksStore";
import { clearAllRemoteStreams, remoteStreamMarks } from "../store/remoteStreams";

const conv: Conversation = {
  id: "c1",
  name: "remote work",
  repoId: "r1",
  cwd: "/srv/app",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: "sess-1",
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

const result = (uuid: string): ConversationItem =>
  ({
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
    uuid,
  }) as ConversationItem;
/** `echo`: the stream's echo of the prompt (`replay: true`) rather than the transcript's line. */
const user = (id: string, echo = true): ConversationItem =>
  ({ kind: "user_message", id, text: `prompt ${id}`, parent_tool_use_id: null, replay: echo }) as ConversationItem;
const said = (id: string): ConversationItem =>
  ({
    kind: "assistant_message",
    id,
    parent_tool_use_id: null,
    turn_id: null,
    blocks: [{ type: "text", text: `answer ${id}` }],
  }) as ConversationItem;

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
  clearAllRemoteStreams();
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [{ id: "r1", path: "/srv/app", addedAt: 1, machineId: "m1" }],
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
  await act(async () => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("what this Mac remembers of a remote stream", () => {
  it("marks it on, at work while a turn runs or a prompt waits, idle after", () => {
    emitState({ busy: true });
    expect(remoteStreamMarks()).toEqual({ c1: { atWork: true } });
    emitState({ busy: false });
    expect(remoteStreamMarks()).toEqual({ c1: { atWork: false } });
    emitState({ awaiting_permission: true });
    expect(remoteStreamMarks()).toEqual({ c1: { atWork: true } });
  });

  it("a replay's held busy is not taken for the conversation's state", () => {
    emitState({ busy: true });
    emitState({ busy: true, replaying: true, replaying_history: true });
    emitState({ busy: true, replaying: true });
    expect(remoteStreamMarks()).toEqual({ c1: { atWork: true } });
    emitState({ busy: false, replaying: false });
    expect(remoteStreamMarks()).toEqual({ c1: { atWork: false } });
  });

  it.each<[SessionEndReason, object | undefined]>([
    ["detached", { atWork: true }],
    ["link_failed", { atWork: true }],
    ["replaced", { atWork: false, replaced: true }],
    ["stopped", undefined],
    ["exited", undefined],
  ])("a session ending as %s leaves the mark %j", (reason, mark) => {
    emitState({ busy: true });
    emitState({ ended: true, end_reason: reason });
    expect(remoteStreamMarks()["c1"]).toEqual(mark);
  });

  it("a conversation on this Mac is never marked", () => {
    useConversationsStore.setState({ repos: [{ id: "r1", path: "/srv/app", addedAt: 1, machineId: null }] });
    emitState({ busy: true });
    expect(remoteStreamMarks()).toEqual({});
  });
});

describe("a first attach over the history read from the server", () => {
  it("places the replayed footers under their own turns", () => {
    // What loadConversationHistory restored from the server's transcript (no results).
    useConversationStore.getState().ensureSession("c1");
    useConversationStore
      .getState()
      .applyItems("c1", [user("u1", false), said("m1"), user("u2", false), said("m2")], true);
    useConversationStore.getState().reanchorReplay("c1");
    // `fd_attach` of a fresh actor: the daemon's whole ring.
    emitState({ replaying: true, replaying_history: true });
    for (const item of [user("u1"), said("m1"), result("r1"), user("u2"), said("m2"), result("r2")]) emitItem(item, true);
    emitState({ replaying: false });
    const timeline = useConversationStore.getState().sessions["c1"].timeline.map((e) => e.id);
    expect(timeline).toEqual(["u1", "m1", "tr_r1", "u2", "m2", "tr_r2"]);
  });

  it("a task failure the replay reports lands where the replay is, not below the history", () => {
    useConversationStore.getState().ensureSession("c1");
    useConversationStore
      .getState()
      .applyItems("c1", [user("u1", false), said("m1"), user("u2", false), said("m2")], true);
    useConversationStore.getState().reanchorReplay("c1");
    emitState({ replaying: true, replaying_history: true });
    for (const item of [user("u1"), said("m1")]) emitItem(item, true);
    fire("sessionTaskEvent", {
      session: "session-1",
      task: {
        task_id: "b1",
        kind: "bash",
        tool_use_id: "t1",
        label: "build",
        command: "make",
        subagent_type: null,
        model: null,
        agent_id: null,
        status: "failed",
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
    for (const item of [result("r1"), user("u2"), said("m2"), result("r2")]) emitItem(item, true);
    emitState({ replaying: false });
    const timeline = useConversationStore.getState().sessions["c1"].timeline.map((e) => e.kind);
    expect(timeline).toEqual(["turn", "turn", "notice", "turn_result", "turn", "turn", "turn_result"]);
  });
});
