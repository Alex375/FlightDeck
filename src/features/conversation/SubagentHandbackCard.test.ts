// A sub-agent's report line, opened on a REMOTE conversation whose agent was woken by a
// SendMessage the core could not tie to its launch (the launch sidecar is on the server): the
// task stays keyed on the SendMessage, while the woken run's own messages stream under the
// LAUNCH. The drill-in must follow the launch (`useAgentStreamKey`), and when the live view
// holds nothing of the run but the wake message, the report in hand is shown under it.
// Same createElement + react-dom/client harness as the other render tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadSubagentTranscript: vi.fn() }));

vi.mock("../../ipc/client", () => ({
  commands: { loadSubagentTranscript: mocks.loadSubagentTranscript },
  events: {},
}));
// The live sub-thread renderer pulls the whole thread renderer in: stand in for it with what
// it was handed — the opening prompt and the turn ids it lists.
vi.mock("./LiveSubThread", async () => {
  const { createElement } = await import("react");
  return {
    LiveSubThread: ({ ids, promptText }: { ids: string[]; promptText: string | null }) =>
      createElement("div", { "data-live": "" }, `prompt:${promptText ?? ""} turns:${ids.join(",")}`),
  };
});
vi.mock("./StreamMarkdown", async () => {
  const { createElement } = await import("react");
  return { StreamMarkdown: ({ text }: { text: string }) => createElement("div", { "data-report": "" }, text) };
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BackgroundTask, ConversationItem } from "../../ipc/client";
import { useBackgroundTasksStore } from "../../store/backgroundTasksStore";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { SubagentHandbackCard } from "./SubagentHandbackCard";

const AGENT = "a68e26aa615c9f436";

const assistant = (id: string, parent: string | null, blocks: unknown[]): ConversationItem =>
  ({ kind: "assistant_message", id, parent_tool_use_id: parent, turn_id: null, blocks }) as ConversationItem;
const result = (toolUseId: string, content: string): ConversationItem =>
  ({ kind: "tool_result", tool_use_id: toolUseId, content, is_error: false, parent_tool_use_id: null }) as ConversationItem;

/** The launch + its ack + the first run, then the wake. `wokenTurns`: whether the woken run's
 *  own message reached the store (under the LAUNCH id, as the wire streams it). */
function seed(wokenTurns: boolean) {
  const items: ConversationItem[] = [
    assistant("m_launch", null, [
      { type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Sleep then reply", prompt: "say BANANA", run_in_background: true } },
    ]),
    result("toolu_agent", `Async agent launched successfully.\nagentId: ${AGENT} (internal ID - do not mention to user.)`),
    assistant("m_sub1", "toolu_agent", [{ type: "text", text: "BANANA" }]),
    assistant("m_wake", null, [
      { type: "tool_use", id: "toolu_send", name: "SendMessage", input: { to: AGENT, message: "now say KIWI", summary: "kiwi" } },
    ]),
    result("toolu_send", '{"success":true,"message":"Resuming agent"}'),
  ];
  if (wokenTurns) items.push(assistant("m_sub2", "toolu_agent", [{ type: "text", text: "KIWI" }]));
  useConversationStore.getState().applyItems("c1", items, true);
  // The core could not re-key the wake (no launch on this Mac's disk): keyed on the SendMessage.
  const task: BackgroundTask = {
    task_id: AGENT,
    kind: "agent",
    tool_use_id: "toolu_send",
    label: "Sleep then reply",
    command: null,
    subagent_type: "general-purpose",
    model: null,
    agent_id: AGENT,
    status: "completed",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: null,
    woken_by: "toolu_send",
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

async function openCard() {
  act(() => {
    root.render(
      createElement(SubagentHandbackCard, {
        session: "c1",
        data: { type: "subagent-handback", agentId: AGENT, report: "The agent said KIWI.", note: null },
      }),
    );
  });
  const row = container.querySelector("button.cv-handback-row") as HTMLButtonElement;
  await act(async () => {
    row.click();
  });
  // Let the (failing) disk read settle.
  await act(async () => {});
}

const live = () => document.body.querySelector("[data-live]")?.textContent ?? "";
const report = () => document.body.querySelector("[data-report]")?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // The transcript is on the server: this Mac's disk has none.
  mocks.loadSubagentTranscript.mockResolvedValue({ status: "error", error: "transcript not found" });
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/srv/app", machineId: "m1" }] as never,
    conversations: [{ id: "c1", repoId: "r1", name: "remote", kind: "claude", sessionId: "sess-1" }] as never,
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

describe("the report line of a sub-agent woken on a remote conversation", () => {
  it("drills into the woken run streamed under the launch, not the SendMessage alone", async () => {
    seed(true);
    await openCard();
    // The wake message opens the view, then ONLY the woken run's turns (after the wake).
    expect(live()).toBe("prompt:now say KIWI turns:m_sub2");
    expect(report()).toBeNull();
  });

  it("shows the report under the wake message when nothing of the run reached the store", async () => {
    seed(false);
    await openCard();
    expect(live()).toBe("prompt:now say KIWI turns:");
    expect(report()).toBe("The agent said KIWI.");
  });
});
