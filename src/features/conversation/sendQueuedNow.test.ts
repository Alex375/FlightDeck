// "Send now" on a pending message (sent while the agent works): offered on BOTH surfaces a
// pending message renders on — the full bubble (`TurnRow` → `MsgUser`) and clean output's
// `InlineUserMarker` — and gated identically on each:
//   - the message is still queued AND addressable on the wire (our uuid), like the cancel
//     cross next to it;
//   - the RUNNING binary advertises the feature (`send_now_available`, from its
//     `system/init`): an older CLI reads the same request as a plain interrupt, a Stop.
// A press names the message by its wire uuid; a failed press is said in the thread WITHOUT
// retiring the pending badge — the message is still waiting in the queue.
//
// Rendered through react-dom/client (zustand's SSR path would only ever see the initial
// state), inside a QueryClientProvider for the mutations. `*.test.ts` → createElement.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InlineUserMarker, TurnRow } from "./ConductorThread";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { commands } from "../../ipc/client";
import type { SessionStatePayload } from "../../ipc/client";

const SESSION = "send-now-conv";
const HANDLE = "session-7";

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

const store = () => useConversationStore.getState();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  useConversationStore.setState({ sessions: {} });
  useConversationsStore.setState({
    conversations: [{ id: SESSION, handle: HANDLE } as unknown as ReturnType<
      typeof useConversationsStore.getState
    >["conversations"][number]],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  useConversationStore.setState({ sessions: {} });
  useConversationsStore.setState({ conversations: [] });
});

/** A pending message of ours: queued, addressable on the wire. */
function pending(): string {
  const id = store().addUserTurn(SESSION, "look at the logs instead", true);
  store().setTurnWireUuid(SESSION, id, "uuid-42");
  return id;
}

/** The running session's state, as far as these controls read it. */
function live(fields: Partial<SessionStatePayload>) {
  act(() => {
    useConversationStore.setState((s) => {
      const entry = s.sessions[SESSION];
      const state = { busy: true, ended: false, send_now_available: true, ...fields } as SessionStatePayload;
      return { sessions: { ...s.sessions, [SESSION]: { ...entry, state } } };
    });
  });
}

function mount(surface: "bubble" | "clean", turnId: string) {
  const el =
    surface === "bubble"
      ? createElement(TurnRow, { session: SESSION, turnId })
      : createElement(InlineUserMarker, { session: SESSION, turnId });
  act(() => {
    root.render(createElement(QueryClientProvider, { client: qc }, el));
  });
}

const sendNowButton = (): HTMLButtonElement | null =>
  container.querySelector('button[aria-label="Send this pending message now"]');
const cancelCross = (): HTMLButtonElement | null =>
  container.querySelector('button[aria-label="Remove this pending message"]');

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe.each(["bubble", "clean"] as const)("Send now on a pending message (%s)", (surface) => {
  it("is offered while the message is pending, ours, and the binary advertises it", () => {
    const id = pending();
    live({});
    mount(surface, id);
    expect(sendNowButton()).not.toBeNull();
    expect(sendNowButton()!.textContent).toContain("send now");
  });

  it("is withheld when the running binary does not advertise it — it would be a Stop", () => {
    const id = pending();
    live({ send_now_available: false });
    mount(surface, id);
    expect(sendNowButton()).toBeNull();
    // The cross does not depend on it.
    expect(cancelCross()).not.toBeNull();
  });

  it("is withheld once the session has ended, or before any state is known", () => {
    const id = pending();
    mount(surface, id);
    expect(sendNowButton()).toBeNull();
    live({ ended: true });
    expect(sendNowButton()).toBeNull();
  });

  it("is withheld for a pending message that is not addressable on the wire (no uuid of ours)", () => {
    const id = store().addUserTurn(SESSION, "typed elsewhere", true);
    live({});
    mount(surface, id);
    expect(sendNowButton()).toBeNull();
  });

  it("goes the moment the message is taken in", () => {
    const id = pending();
    live({});
    mount(surface, id);
    expect(sendNowButton()).not.toBeNull();
    act(() => {
      // The next root model call is the delivery boundary (clearQueuedBadges).
      store().applyItem(SESSION, { kind: "message_started", id: "m1", parent_tool_use_id: null } as never);
    });
    expect(sendNowButton()).toBeNull();
  });

  it("names the pressed message by its wire uuid, then cannot be pressed twice", async () => {
    const spy = vi.spyOn(commands, "sendQueuedMessageNow").mockResolvedValue({ status: "ok", data: "stopped" });
    const id = pending();
    live({});
    mount(surface, id);
    act(() => sendNowButton()!.click());
    await settle();
    expect(spy).toHaveBeenCalledWith(HANDLE, "uuid-42");
    expect(sendNowButton()!.disabled).toBe(true);
    expect(sendNowButton()!.textContent).toContain("sending");
  });

  it("says a refusal in the thread and leaves the message pending (it is still queued)", async () => {
    vi.spyOn(commands, "sendQueuedMessageNow").mockResolvedValue({
      status: "error",
      error: "Not connected to box right now — try again once the link is back.",
    });
    const id = pending();
    live({});
    mount(surface, id);
    act(() => sendNowButton()!.click());
    await settle();
    const entry = store().sessions[SESSION];
    const notices = Object.values(entry.notices);
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0].detail)).toContain("Could not send the pending message now");
    expect(JSON.stringify(notices[0].detail)).toContain("stays queued");
    // Still pending: badge kept, both controls still offered, Send now pressable again.
    expect(entry.turns[id].queued).toBe(true);
    expect(cancelCross()).not.toBeNull();
    expect(sendNowButton()!.disabled).toBe(false);
  });
});
