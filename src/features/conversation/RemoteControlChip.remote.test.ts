// Remote Control on a conversation whose REMOTE link is down (reconnecting, or its first link
// still coming up). Switching the bridge is a request to the server's `claude`: it could only
// fail — and its "error" answer would replace the bridge state the chip holds, one still true on
// the server (its claude.ai link included), with nothing on the wire to bring it back. So the
// switch is not offered, saying why; a caller that tries anyway (app control, a race) gets the
// reason in the thread and the chip's state is left alone. Same createElement + react-dom/client
// harness as the other render tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setRemoteControl: vi.fn() }));

vi.mock("../../ipc/client", () => ({
  commands: { setRemoteControl: mocks.setRemoteControl },
  events: {},
}));
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
    act(() => useConversationStore.getState().applyState("c1", state({ link: { kind: "reconnecting", attempt: 2 } })));
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
    act(() => useConversationStore.getState().applyState("c1", state({ link: { kind: "reconnecting", attempt: 1 } })));
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
