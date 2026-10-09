// A sub-agent's transcript drill-in (AgentBar / Flight Deck badge / handback) on a conversation
// running on a PAIRED SERVER. The transcript lives on the server, so the popover reads it through
// the read routed by CONVERSATION (`loadSubagentTranscript(convId, …)`), handing the stream's own
// location for it (the task's `output_file`) so the server needs no search — and, since each read
// is an ssh round trip, it skips the read while the live sub-thread is streaming (the live view
// wins then anyway) and reads at the settle edge instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadSubagentTranscript: vi.fn() }));

vi.mock("../../ipc/client", () => ({
  commands: { loadSubagentTranscript: mocks.loadSubagentTranscript },
  events: {},
}));
// Stand-ins for the two renderers: what each was handed is what this test checks.
vi.mock("./LiveSubThread", async () => {
  const { createElement } = await import("react");
  return {
    LiveSubThread: ({ ids }: { ids: string[] }) => createElement("div", { "data-live": "" }, `live:${ids.join(",")}`),
  };
});
vi.mock("./SubAgentTranscript", async () => {
  const { createElement } = await import("react");
  return {
    SubAgentTranscript: ({ items }: { items: unknown[] }) => createElement("div", { "data-disk": "" }, `disk:${items.length}`),
  };
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BackgroundTask, ConversationItem } from "../../ipc/client";
import { useBackgroundTasksStore } from "../../store/backgroundTasksStore";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { TranscriptPopover } from "./TranscriptPopover";

const AGENT = "a68e26aa615c9f436";
const OUTPUT = `/tmp/claude-1000/-srv-app/sess-1/tasks/${AGENT}.output`;
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const assistant = (id: string, parent: string | null, blocks: unknown[]): ConversationItem =>
  ({ kind: "assistant_message", id, parent_tool_use_id: parent, turn_id: null, blocks }) as ConversationItem;

function seed(withLiveTurns: boolean) {
  const items: ConversationItem[] = [
    assistant("m_launch", null, [
      { type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Review", prompt: "review it", run_in_background: true } },
    ]),
  ];
  if (withLiveTurns) items.push(assistant("m_sub1", "toolu_agent", [{ type: "text", text: "looking…" }]));
  useConversationStore.getState().applyItems("c1", items, true);
  const task: BackgroundTask = {
    task_id: AGENT,
    kind: "agent",
    tool_use_id: "toolu_agent",
    label: "Review",
    command: null,
    subagent_type: "general-purpose",
    model: null,
    agent_id: AGENT,
    status: "running",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: OUTPUT,
    woken_by: null,
    backgrounded: true,
    ambient: false,
    owned_by_subagent: false,
    time_limit_ms: null,
    deadline_at_ms: null,
    stop_cause: null,
  };
  useBackgroundTasksStore.getState().applyTask("c1", task);
}

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => {});

function mount(running: boolean) {
  act(() => {
    root.render(
      createElement(TranscriptPopover, {
        open: true,
        sessionId: "sess-1",
        agentId: AGENT,
        liveSession: "c1",
        toolUseId: "toolu_agent",
        running,
        label: "Review",
        onClose: () => {},
      }),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.loadSubagentTranscript.mockResolvedValue(
    ok([assistant("d1", null, []), assistant("d2", null, []), assistant("d3", null, [])]),
  );
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [{ id: "r1", path: "/srv/app", machineId: "m1" }] as never,
    conversations: [
      { id: "c1", repoId: "r1", name: "remote", kind: "claude", sessionId: "sess-1", handle: "session-1" },
    ] as never,
  });
  useConversationStore.setState({ sessions: {} });
  useBackgroundTasksStore.getState().clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const body = () => document.body.textContent ?? "";

describe("TranscriptPopover on a conversation running on a paired server", () => {
  it("while the sub-thread streams live, opening costs no round trip; the settle edge reads the server", async () => {
    seed(true);
    mount(true);
    await flush();
    expect(body()).toContain("live:m_sub1");
    expect(mocks.loadSubagentTranscript).not.toHaveBeenCalled();

    mount(false);
    await flush();
    expect(mocks.loadSubagentTranscript).toHaveBeenCalledWith("c1", "sess-1", AGENT, OUTPUT);
    // Finished: the full transcript from the server is authoritative.
    expect(body()).toContain("disk:3");
  });

  it("once the session stopped streaming while the run goes on (the phone took it over), the server's transcript is read and shown", async () => {
    seed(true);
    mount(true);
    await flush();
    expect(body()).toContain("live:m_sub1");
    expect(mocks.loadSubagentTranscript).not.toHaveBeenCalled();
    // The session ends (replaced): the task is kept running — the process lives on — but
    // nothing streams it here any more.
    act(() => {
      useConversationsStore.setState((s) => ({
        conversations: s.conversations.map((c) => (c.id === "c1" ? { ...c, handle: null } : c)),
      }));
    });
    await flush();
    expect(mocks.loadSubagentTranscript).toHaveBeenCalledWith("c1", "sess-1", AGENT, OUTPUT);
    expect(body()).toContain("disk:3");
    expect(body()).not.toContain("live:m_sub1");
  });

  it("with no live sub-thread, opening reads the server's transcript (the stream's path as the hint)", async () => {
    seed(false);
    mount(false);
    await flush();
    expect(mocks.loadSubagentTranscript).toHaveBeenCalledWith("c1", "sess-1", AGENT, OUTPUT);
    expect(body()).toContain("disk:3");
    expect(body()).not.toContain("hasn't written a transcript");
  });

  it("an unreachable server is named in the error", async () => {
    seed(false);
    mocks.loadSubagentTranscript.mockResolvedValue({
      status: "error",
      error: { kind: "unreachable", server: "Target", reason: "could not reach the server" },
    });
    mount(false);
    await flush();
    expect(body()).toContain("Transcript unreadable: couldn't reach Target — could not reach the server");
  });

  it("re-targeted to another agent (one popover per AgentBar / badge), it never shows the previous agent's transcript", async () => {
    seed(false);
    const B = "b11112222333344445";
    const render = (agentId: string | null, open = true) =>
      act(() => {
        root.render(
          createElement(TranscriptPopover, {
            open,
            sessionId: "sess-1",
            agentId,
            liveSession: "c1",
            toolUseId: agentId === AGENT ? "toolu_agent" : "toolu_other",
            running: false,
            label: agentId ?? "",
            onClose: () => {},
          }),
        );
      });
    // Agent A's transcript is read and shown.
    render(AGENT);
    await flush();
    expect(body()).toContain("disk:3");
    // Closed, then B opened: its read is still on its way back from the server…
    render(null, false);
    let answerB!: (v: unknown) => void;
    mocks.loadSubagentTranscript.mockImplementationOnce(() => new Promise((r) => (answerB = r)));
    render(B);
    await flush();
    // …A's items are gone at once: nothing of A is shown under B's header.
    expect(body()).not.toContain("disk:3");
    expect(body()).toContain("Loading transcript…");
    // B's read fails: its error is shown — never A's transcript in its place.
    await act(async () =>
      answerB({ status: "error", error: { kind: "unreachable", server: "Target", reason: "could not reach the server" } }),
    );
    expect(body()).not.toContain("disk:3");
    expect(body()).toContain("Transcript unreadable: couldn't reach Target");
  });

  it("a read for the previous agent landing late is dropped, not shown under the new one", async () => {
    seed(false);
    const B = "b11112222333344445";
    let answerA!: (v: unknown) => void;
    mocks.loadSubagentTranscript
      .mockImplementationOnce(() => new Promise((r) => (answerA = r)))
      .mockResolvedValueOnce(ok([assistant("b1", null, [])]));
    const render = (agentId: string) =>
      act(() => {
        root.render(
          createElement(TranscriptPopover, {
            open: true,
            sessionId: "sess-1",
            agentId,
            liveSession: "c1",
            toolUseId: null,
            running: false,
            label: agentId,
            onClose: () => {},
          }),
        );
      });
    render(AGENT);
    render(B);
    await flush();
    expect(body()).toContain("disk:1");
    // A's (slow) answer lands now: B's view keeps B's transcript.
    await act(async () => answerA(ok([assistant("d1", null, []), assistant("d2", null, []), assistant("d3", null, [])])));
    expect(body()).toContain("disk:1");
    expect(body()).not.toContain("disk:3");
  });
});
