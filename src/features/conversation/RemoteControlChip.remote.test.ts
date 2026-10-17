// Remote Control on a conversation whose REMOTE link is down (reconnecting, or its first link
// still coming up). Switching the bridge is a request to the server's `claude`: it could only
// fail — and its "error" answer would replace the bridge state the chip holds, one still true on
// the server (its claude.ai link included), with nothing on the wire to bring it back. So the
// switch is not offered, saying why; a caller that tries anyway (app control, a race) gets the
// reason in the thread and the chip's state is left alone. Same createElement + react-dom/client
// harness as the other render tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setRemoteControl: vi.fn(), ensure: vi.fn() }));

vi.mock("../../ipc/client", () => ({
  commands: { setRemoteControl: mocks.setRemoteControl },
  events: {},
}));
// The reattach a disable needs (the real one spawns a session through IPC): recorded, then
// handed the real store's live handle when there is one.
vi.mock("../../store/conversationsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/conversationsStore")>();
  return {
    ...actual,
    ensureConversationSession: async (convId: string) => {
      mocks.ensure(convId);
      return actual.liveHandle(convId) ?? "session-2";
    },
  };
});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RemoteControlState, SessionStatePayload } from "../../ipc/client";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useRemoteControlStore } from "../../store/remoteControl";
import { RemoteControlChip } from "./RemoteControlChip";

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

const kept: RemoteControlState = {
  status: "connected",
  session_url: "https://claude.ai/code/session_1",
  error: null,
  pairing_code: null,
};

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

function mount() {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(RemoteControlChip, { session: "c1", backend: "claude" }),
      ),
    );
  });
}

const toggle = () => container.querySelector("button.cv-rc-chip") as HTMLButtonElement | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [{ id: "r1", path: "/srv/app", machineId: "m1" }] as never,
    conversations: [{ id: "c1", repoId: "r1", name: "remote", kind: "claude", handle: "session-1" }] as never,
  });
  useConversationStore.setState({ sessions: {} });
  useRemoteControlStore.getState().clearAll();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the Remote Control chip while a remote link is down", () => {
  it("offers no switch, and says why — naming the server", () => {
    act(() => useConversationStore.getState().applyState("c1", state({ link: { kind: "reconnecting", attempt: 2, since_ms: 0, retry_at_ms: null, slowed: false } })));
    mount();
    const button = toggle()!;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("Not connected to Target right now");
  });

  it("offers it again once the link is back", () => {
    act(() => useConversationStore.getState().applyState("c1", state({ link: null })));
    mount();
    expect(toggle()!.disabled).toBe(false);
  });

  it("keeps the bridge state it holds when a switch is tried anyway", async () => {
    act(() => useConversationStore.getState().applyState("c1", state({ link: { kind: "reconnecting", attempt: 1, since_ms: 0, retry_at_ms: null, slowed: false } })));
    useRemoteControlStore.getState().set("c1", kept);
    const { useSetRemoteControl } = await import("../../ipc/useCommands");
    let mutate: ((v: { enabled: boolean }) => Promise<unknown>) | null = null;
    function Probe() {
      mutate = useSetRemoteControl("c1").mutateAsync;
      return null;
    }
    act(() => {
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe)));
    });
    await act(async () => {
      await mutate!({ enabled: false });
    });
    expect(mocks.setRemoteControl).not.toHaveBeenCalled();
    expect(useRemoteControlStore.getState().byConv["c1"]).toEqual(kept);
    const errors = Object.values(useConversationStore.getState().sessions["c1"].errors);
    expect(errors.map((e) => e.message).join("\n")).toContain("Not connected to Target right now");
  });
});

// The link went down AFTER the request left the front (the core refused it on arrival, or
// took its reply with the link): the core answers "unanswered" — whether the toggle reached
// the server is unknown, so the chip is put back as it was, and the thread says why.
describe("a bridge toggle a remote link took", () => {
  async function probe() {
    const { useSetRemoteControl } = await import("../../ipc/useCommands");
    let mutate: ((v: { enabled: boolean }) => Promise<unknown>) | null = null;
    function Probe() {
      mutate = useSetRemoteControl("c1").mutateAsync;
      return null;
    }
    act(() => {
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe)));
    });
    return (v: { enabled: boolean }) => act(async () => void (await mutate!(v)));
  }
  const unanswered = {
    status: "ok",
    data: {
      status: "unanswered",
      session_url: null,
      error: "Not answered: the link to Target dropped. Try again.",
      pairing_code: null,
    },
  };
  const errorsText = () =>
    Object.values(useConversationStore.getState().sessions["c1"]?.errors ?? {})
      .map((e) => e.message)
      .join("\n");

  beforeEach(() => {
    act(() => useConversationStore.getState().applyState("c1", state({ link: null })));
  });

  it("puts back the bridge state shown before the toggle, and says why", async () => {
    useRemoteControlStore.getState().set("c1", kept);
    mocks.setRemoteControl.mockResolvedValue(unanswered);
    const run = await probe();
    await run({ enabled: false });
    expect(mocks.setRemoteControl).toHaveBeenCalledWith("session-1", false, null);
    expect(useRemoteControlStore.getState().byConv["c1"]).toEqual(kept);
    expect(errorsText()).toContain("Not answered: the link to Target dropped");
  });

  it("drops the optimistic connecting when there was nothing before", async () => {
    mocks.setRemoteControl.mockResolvedValue(unanswered);
    const run = await probe();
    await run({ enabled: true });
    expect(useRemoteControlStore.getState().byConv["c1"]).toBeUndefined();
  });

  it("leaves a state the core said meanwhile (a restarted process's disconnected)", async () => {
    useRemoteControlStore.getState().set("c1", kept);
    const disconnected: RemoteControlState = { status: "disconnected", session_url: null, error: null, pairing_code: null };
    mocks.setRemoteControl.mockImplementation(async () => {
      useRemoteControlStore.getState().set("c1", disconnected);
      return unanswered;
    });
    const run = await probe();
    await run({ enabled: true });
    expect(useRemoteControlStore.getState().byConv["c1"]).toEqual(disconnected);
  });
});

// The session ended but its server-side process lives on (the phone took the conversation
// over): the bridge is still up there, so Disable turns it off THERE — reattaching first —
// instead of clearing the chip over a bridge still reachable from claude.ai.
describe("disabling the bridge of a remote session that ended while its process lives on", () => {
  async function disable() {
    const { useSetRemoteControl } = await import("../../ipc/useCommands");
    let mutate: ((v: { enabled: boolean }) => Promise<unknown>) | null = null;
    function Probe() {
      mutate = useSetRemoteControl("c1").mutateAsync;
      return null;
    }
    act(() => {
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe)));
    });
    await act(async () => {
      await mutate!({ enabled: false });
    });
  }

  it("reattaches and turns the bridge off on the server", async () => {
    useConversationsStore.setState({
      conversations: [{ id: "c1", repoId: "r1", name: "remote", kind: "claude", handle: null }] as never,
    });
    act(() => useConversationStore.getState().applyState("c1", state({ ended: true })));
    useRemoteControlStore.getState().set("c1", kept);
    mocks.setRemoteControl.mockResolvedValue({
      status: "ok",
      data: { status: "disconnected", session_url: null, error: null, pairing_code: null },
    });
    await disable();
    expect(mocks.ensure).toHaveBeenCalledWith("c1");
    expect(mocks.setRemoteControl).toHaveBeenCalledWith("session-2", false, null);
    expect(useRemoteControlStore.getState().byConv["c1"]?.status).toBe("disconnected");
  });

  it("only clears the chip of a local conversation (its bridge went with the process)", async () => {
    useConversationsStore.setState({
      machines: [] as never,
      repos: [{ id: "r1", path: "/srv/app", machineId: null }] as never,
      conversations: [{ id: "c1", repoId: "r1", name: "local", kind: "claude", handle: null }] as never,
    });
    useRemoteControlStore.getState().set("c1", kept);
    await disable();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.setRemoteControl).not.toHaveBeenCalled();
    expect(useRemoteControlStore.getState().byConv["c1"]?.status).toBe("disconnected");
  });
});
