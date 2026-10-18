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
import type { BackgroundTask, ConversationItem, SessionStatePayload } from "./client";
import { useGlobalSessionEvents } from "./useGlobalSessionEvents";
import { useConversationsStore, type Conversation } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import { useBackgroundTasksStore } from "../store/backgroundTasksStore";
import { useRemoteControlStore } from "../store/remoteControl";
import { serverSessionOutlives } from "../agent/sessionEnd";
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

// A REMOTE session can END on this Mac while its `claude` lives on server-side: another client
// took the conversation over, this Mac let go, the link failed for good. Its background work
// and its Remote Control bridge outlive the session here — the front must not claim them
// stopped. A process that is really gone (a remote exit or stop, any local end) still
// reconciles its running tasks to stopped and drops the bridge.
describe("the end of a session", () => {
  const running = {
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
  };
  const bridge = { status: "connected", session_url: "https://claude.ai/code/s1", error: null, pairing_code: null };

  function endWith(reason: SessionStatePayload["end_reason"]) {
    fire("sessionTaskEvent", { session: "session-1", task: running });
    useRemoteControlStore.getState().set("c1", bridge);
    emitState({ ended: true, end_reason: reason });
  }

  it("another client taking it over leaves the server's work running and its bridge up", () => {
    endWith("replaced");
    expect(useBackgroundTasksStore.getState().sessions["c1"]["b1"].status).toBe("running");
    expect(useRemoteControlStore.getState().byConv["c1"]).toEqual(bridge);
    expect(useConversationsStore.getState().conversations[0].handle).toBeNull();
  });

  it("a remote claude that exited takes its work and its bridge with it", () => {
    endWith("exited");
    expect(useBackgroundTasksStore.getState().sessions["c1"]["b1"].status).toBe("stopped");
    expect(useRemoteControlStore.getState().byConv["c1"]).toBeUndefined();
  });

  // The daemon refuses an attach only when it has no process to join (the one it held just
  // ended, a cold start failed): its work must not stay shown running for good.
  it("a reconnect the daemon refused takes the work and the bridge with it", () => {
    endWith("attach_failed");
    expect(useBackgroundTasksStore.getState().sessions["c1"]["b1"].status).toBe("stopped");
    expect(useRemoteControlStore.getState().byConv["c1"]).toBeUndefined();
  });

  it("tells which ends the server-side process outlives", () => {
    expect(serverSessionOutlives("replaced")).toBe(true);
    expect(serverSessionOutlives("detached")).toBe(true);
    expect(serverSessionOutlives("link_failed")).toBe(true);
    expect(serverSessionOutlives("attach_failed")).toBe(false);
    expect(serverSessionOutlives("exited")).toBe(false);
    expect(serverSessionOutlives("stopped")).toBe(false);
    // No reason given (Codex, a local end before the field existed): the process is gone.
    expect(serverSessionOutlives(null)).toBe(false);
    expect(serverSessionOutlives(undefined)).toBe(false);
  });
});

// Review fixes of the replay handling (CRM b87a5aeb).
describe("what a replay settles, and what it must leave alone", () => {
  const task = (o: Partial<BackgroundTask>): BackgroundTask =>
    ({
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
      ...o,
    }) as BackgroundTask;
  const emitTask = (t: BackgroundTask) => fire("sessionTaskEvent", { session: "session-1", task: t });
  const st = () => useConversationStore.getState();
  const result = (uuid: string): ConversationItem => ({ ...toolTurn[3], uuid }) as ConversationItem;
  const failedNotices = () =>
    Object.values(st().sessions["c1"].notices).filter((n) => n.subtype === "task_failed");
  const lastRun = () => {
    const runs = st().sessions["c1"].runClock.runs;
    return runs[runs.length - 1];
  };

  it("a background task that ended while the Mac was away ends its run (replayed end)", () => {
    st().addUserTurn("c1", "start the dev server");
    emitState({ busy: true });
    emitTask(task({ status: "running" }));
    emitItem(result("r1"), false);
    emitState({ busy: false });
    const live = lastRun();
    expect(live.running).toEqual(["b1"]);
    expect(live.endedAt).toBeNull();

    emitState({ replaying: true });
    emitTask(task({ status: "completed" }));
    emitState({ replaying: false });
    const after = lastRun();
    expect(after.running).toEqual([]);
    expect(after.endedAt).toBeTypeOf("number");
  });

  it("a task first seen running in a replay starts no run clock", () => {
    st().addUserTurn("c1", "go");
    emitState({ busy: true });
    emitState({ busy: true, replaying: true });
    emitTask(task({ task_id: "b2", status: "running" }));
    emitState({ busy: true, replaying: false });
    expect(lastRun().running).toEqual([]);
  });

  it("two runs of one task failing the same way get a notice each; a re-delivered end keeps one", () => {
    const agent = (status: BackgroundTask["status"], run_id: string) =>
      task({ task_id: "a1", kind: "agent", status, run_id });
    // A sub-agent woken by ANOTHER sub-agent: `woken_by` is empty for both runs.
    emitTask(agent("running", "0a-1"));
    emitTask(agent("failed", "0a-1"));
    emitTask(agent("running", "0b-2"));
    emitTask(agent("failed", "0b-2"));
    expect(failedNotices()).toHaveLength(2);
    // A re-join's replay re-delivers the second run from its start.
    emitState({ replaying: true });
    emitTask(agent("running", "0b-2"));
    emitTask(agent("failed", "0b-2"));
    emitState({ replaying: false });
    expect(failedNotices()).toHaveLength(2);
  });

  it("a CLI that names no run keys the notice as any other, never merging two runs", () => {
    emitTask(task({ task_id: "a2", kind: "agent", status: "running" }));
    emitTask(task({ task_id: "a2", kind: "agent", status: "failed" }));
    emitTask(task({ task_id: "a2", kind: "agent", status: "running" }));
    emitTask(task({ task_id: "a2", kind: "agent", status: "failed" }));
    const notices = failedNotices();
    expect(notices).toHaveLength(2);
    for (const n of notices) expect((n.detail as Record<string, unknown>).source_id).toBeUndefined();
  });

  it("a whole-history replay into a conversation already seen leaves it seen (and persisted so)", () => {
    emitState({ replaying: true, replaying_history: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    expect(st().sessions["c1"].turnSeen).toBe(true);
    expect(useConversationsStore.getState().conversations[0].pendingReminder).toBeNull();
  });

  it("a whole-history replay keeps a review the user had not seen yet", () => {
    useConversationsStore.setState({ conversations: [{ ...conv, pendingReminder: "review" }] });
    emitState({ replaying: true, replaying_history: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    expect(st().sessions["c1"].turnSeen).toBe(false);
    expect(useConversationsStore.getState().conversations[0].pendingReminder).toBe("review");
  });

  it("a result missed during an outage is news: there is something to review", () => {
    emitState({ replaying: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    expect(st().sessions["c1"].turnSeen).toBe(false);
  });

  it("a whole-history replay into a conversation that held results reviews only the new ones", () => {
    emitState({ replaying: true, replaying_history: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    st().markSeen("c1");
    // A re-join: the same history again (de-duplicated), then a turn that ended meanwhile.
    emitState({ replaying: true, replaying_history: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    expect(st().sessions["c1"].turnSeen).toBe(true);
    emitState({ replaying: true, replaying_history: true });
    emitItem(result("r2"), true);
    emitState({ replaying: false });
    expect(st().sessions["c1"].turnSeen).toBe(false);
  });

  it("the message that spawned the session lands BELOW the history the replay brings", () => {
    const sent = st().addUserTurn("c1", "and now?");
    emitState({ replaying: true, replaying_history: true });
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    const timeline = st().sessions["c1"].timeline;
    expect(timeline[timeline.length - 1]).toEqual({ kind: "turn", id: sent });
    expect(timeline.findIndex((e) => e.kind === "turn" && e.id === "m1")).toBeLessThan(timeline.length - 1);
    expect(st().sessions["c1"].replayAnchor).toBe(timeline.length);
  });

  it("a message sent during a whole-history replay stays below the one that spawned it", () => {
    const first = st().addUserTurn("c1", "first");
    emitState({ replaying: true, replaying_history: true });
    for (const item of toolTurn) emitItem(item, true);
    // Sent while the replay is still coming in (part of it still queued for the next frame).
    const second = st().addUserTurn("c1", "second");
    emitState({ replaying: false });
    const ids = st().sessions["c1"].timeline.map((e) => e.id);
    expect(ids.indexOf("m1")).toBeLessThan(ids.indexOf(first));
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
  });

  it("after a cut replay the spawning message stays above its reply, which is news", () => {
    // The core held the message until the attach and wrote it during the first replay; the
    // link died mid-replay, the daemon ran it meanwhile, and the rest of the replay brings
    // its echo (surfaced as history by the core) and its reply.
    const sent = st().addUserTurn("c1", "first");
    st().setTurnWireUuid("c1", sent, "w1");
    emitState({ replaying: true, replaying_history: true });
    emitItem({ kind: "message_started", id: "m0", role: "assistant", parent_tool_use_id: null } as ConversationItem, true);
    emitItem(result("r0"), true);
    emitItem(
      { kind: "user_message", id: "w1", text: "first", parent_tool_use_id: null, replay: true } as ConversationItem,
      true,
    );
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    const ids = st().sessions["c1"].timeline.map((e) => e.id);
    expect(ids.indexOf(sent)).toBeLessThan(ids.indexOf("m1"));
    // The user has not seen the answer to the message they just sent.
    expect(st().sessions["c1"].turnSeen).toBe(false);
  });

  it("a message an earlier session sent sits at its replayed echo, above its own reply", () => {
    const sent = st().addUserTurn("c1", "first");
    st().setTurnWireUuid("c1", sent, "w1");
    emitState({ replaying: true, replaying_history: true });
    // History before that message, then its echo, then its reply.
    emitItem({ kind: "message_started", id: "m0", role: "assistant", parent_tool_use_id: null } as ConversationItem, true);
    emitItem(result("r0"), true);
    emitItem(
      { kind: "user_message", id: "w1", text: "first", parent_tool_use_id: null, replay: true } as ConversationItem,
      true,
    );
    for (const item of toolTurn) emitItem(item, true);
    emitState({ replaying: false });
    const ids = st().sessions["c1"].timeline.map((e) => e.id);
    expect(ids.indexOf("m0")).toBeLessThan(ids.indexOf(sent));
    expect(ids.indexOf(sent)).toBeLessThan(ids.indexOf("m1"));
    expect(ids.filter((id) => id === sent)).toHaveLength(1);
  });
});
