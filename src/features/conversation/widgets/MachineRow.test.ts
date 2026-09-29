// The Machine footer row, mounted — what the pure module (`machines/machineWidget.ts`) cannot
// pin on its own: the local early return, the unknown server never reading local, the buttons'
// refused-but-focusable pending state, and a failed reconnect living exactly as long as the link
// state it was about.
//
// Built with createElement in a `*.test.ts` file + react-dom/client (the Tooltip portals), with
// the REAL stores seeded directly and the browser-mock `commands` spied on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { commands, type SessionStatePayload } from "../../../ipc/client";
import { useConversationStore } from "../../../store/conversationStore";
import { useConversationsStore, type Conversation, type Machine } from "../../../store/conversationsStore";
import { resetProbeStateForTests, useMachineHealthStore } from "../../../store/machineHealth";
import type { SessionEntry } from "../../../store/types";
import { MachineRow } from "./MachineRow";

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

const MACHINE: Machine = {
  id: "m1",
  label: "Base",
  host: "base.tail",
  port: 22,
  user: "alex",
  identityFile: null,
  addedAt: 0,
  addresses: [],
};

/** Only the fields the row reads — cast, so a field another feature adds to `Conversation`
 *  does not break a test that has nothing to say about it. */
function conv(over: Partial<Conversation> = {}): Conversation {
  return { id: "c1", repoId: "r1", handle: null, kind: "claude", ...over } as unknown as Conversation;
}

function seed(machineId: string | null, machines: Machine[] = [MACHINE]) {
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/srv/app", addedAt: 0, machineId }],
    machines,
  });
}

function setLink(state: Partial<SessionStatePayload> | null) {
  useConversationStore.setState({
    sessions: state
      ? {
          c1: {
            state: { ended: false, link: null, session_id: "sess", ...state } as SessionStatePayload,
          } as unknown as SessionEntry,
        }
      : {},
  });
}

function mount(c: Conversation) {
  act(() => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(MachineRow, { conv: c })));
  });
}

/** Let promises land — and TanStack Query's notify batch, which it schedules on a timer. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const buttons = () => Array.from(container.querySelectorAll("button"));
const button = (label: RegExp) => buttons().find((b) => label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useMachineHealthStore.setState({ byMachine: {} });
  resetProbeStateForTests();
  setLink(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("MachineRow — where", () => {
  it("renders nothing when the conversation's repo is not in the store", () => {
    useConversationsStore.setState({ repos: [], machines: [MACHINE] });
    mount(conv());
    expect(container.innerHTML).toBe("");
  });

  it("names this Mac, with no actions, for a local folder", async () => {
    seed(null);
    vi.spyOn(commands, "localMachineName").mockResolvedValue("Studio");
    mount(conv());
    await settle();
    expect(container.textContent).toContain("Studio");
    expect(container.textContent).toContain("This Mac");
    expect(buttons()).toHaveLength(0);
  });

  it("reads 'This Mac' / 'Local' when the Mac's name is unavailable", async () => {
    seed(null);
    vi.spyOn(commands, "localMachineName").mockResolvedValue(null);
    mount(conv());
    await settle();
    expect(container.textContent).toBe("This MacLocal");
  });

  // ⚠️ The regression the remote mark exists to prevent: an unpaired server is still a server.
  it("reads an unpaired machine as an unknown server — never this Mac — and offers only the server panel", () => {
    seed("gone");
    const name = vi.spyOn(commands, "localMachineName");
    mount(conv());
    expect(container.textContent).toContain("Unknown server");
    expect(container.textContent).not.toContain("This Mac");
    expect(buttons().map((b) => b.textContent)).toEqual(["Server"]);
    expect(name).not.toHaveBeenCalled();
  });
});

describe("MachineRow — a paired server", () => {
  it("shows an em dash, never a fake verdict, before any check", () => {
    seed("m1");
    mount(conv());
    expect(container.textContent).toContain("Base");
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("Reachable");
  });

  // `aria-disabled`, not `disabled`: focus stays on the button Enter just pressed, and its
  // "Checking…" hint stays hoverable. A second press is refused, not re-dialled.
  it("keeps Check now focusable while the check is out, and refuses a second press", async () => {
    seed("m1");
    let answer: (v: Awaited<ReturnType<typeof commands.machineReachability>>) => void = () => {};
    const probe = vi
      .spyOn(commands, "machineReachability")
      .mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    mount(conv());
    const check = button(/Check the server now/)!;
    check.focus();
    act(() => check.click());
    const busy = button(/Checking the server/)!;
    expect(busy).toBe(check);
    expect(busy.disabled).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(busy);
    expect(container.textContent).toContain("Checking…");
    act(() => busy.click());
    expect(probe).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({ status: "ok", data: { reachable: true, reason: null } });
      await Promise.resolve();
    });
    await settle();
    expect(button(/Check the server now/)?.hasAttribute("aria-busy")).toBe(false);
    expect(container.textContent).toContain("Reachable · checked just now");
  });

  it("says Connected while a session is attached, with no Reconnect to offer", () => {
    seed("m1");
    setLink({});
    mount(conv({ handle: "session-1" }));
    expect(container.textContent).toContain("Connected");
    expect(button(/Reconnect now/)).toBeUndefined();
  });

  it("shows a failed reconnect until the link moves on", async () => {
    seed("m1");
    setLink({ link: { kind: "reconnecting", attempt: 2 } });
    vi.spyOn(commands, "reconnectRemoteSessions").mockResolvedValue({ status: "error", error: "no route" });
    mount(conv({ handle: "session-1" }));
    expect(container.textContent).toContain("Reconnecting… attempt 2");
    act(() => button(/Reconnect now/)!.click());
    await settle();
    expect(container.textContent).toContain("Reconnect failed · no route");
    // A new attempt is a new situation: the old failure is not about it.
    act(() => setLink({ link: { kind: "reconnecting", attempt: 3 } }));
    expect(container.textContent).not.toContain("Reconnect failed");
    expect(container.textContent).toContain("Reconnecting… attempt 3");
  });

  // ⚠️ Stamped when it LANDS: a key captured at click time dropped the error in silence when
  // the attempt ticked over during the round trip.
  it("never swallows a reconnect failure that lands after the link moved", async () => {
    seed("m1");
    setLink({ link: { kind: "reconnecting", attempt: 2 } });
    let answer: (v: Awaited<ReturnType<typeof commands.reconnectRemoteSessions>>) => void = () => {};
    const nudge = vi
      .spyOn(commands, "reconnectRemoteSessions")
      .mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    mount(conv({ handle: "session-1" }));
    const reconnect = button(/Reconnect now/)!;
    act(() => reconnect.click());
    expect(reconnect.disabled).toBe(false);
    expect(reconnect.getAttribute("aria-disabled")).toBe("true");
    // A second press while the nudge is out is refused.
    act(() => reconnect.click());
    expect(nudge).toHaveBeenCalledTimes(1);
    act(() => setLink({ link: { kind: "reconnecting", attempt: 3 } }));
    await act(async () => {
      answer({ status: "error", error: "no route" });
      await Promise.resolve();
    });
    await settle();
    expect(container.textContent).toContain("Reconnect failed · no route");
  });

  it("tells a Codex conversation it cannot run on the server, and never offers Reconnect", () => {
    seed("m1");
    setLink({ link: { kind: "reconnecting", attempt: 1 } });
    mount(conv({ kind: "codex", handle: "session-1" }));
    expect(container.textContent).toContain("Codex can't run on a server");
    expect(container.textContent).not.toContain("Connected");
    expect(button(/Reconnect now/)).toBeUndefined();
  });
});
