// Mounts the "Linked conversations" widget against real stores (react-dom/client — a server
// render would see zustand's INITIAL state, not the one set here): null with no link, one row
// per partner with its live name, the figures and what they say in words, the gone-partner
// degradation (an unknown name is an em dash on screen, never read aloud), both jumps, the
// reply slot kept on a row with nothing to scroll to, the « Show N more » cap, the motion gate,
// and the fold unmounting the rows while the header keeps its count.
//
// Built with createElement in a `*.test.ts` file, same discipline as the other mounted tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { JsonValue, NormalizedBlock } from "../../../ipc/client";
import { useConversationStore } from "../../../store/conversationStore";
import { useConversationsStore, type Conversation } from "../../../store/conversationsStore";
import { useDisplay } from "../../../store/display";
import { useSidePanelLayout } from "../../../store/sidePanelWidgetsStore";
import { useThreadJump } from "../../../store/threadJump";
import type { SessionEntry } from "../../../store/types";
import { CREATE_CONVERSATION_TOOL, SEND_MESSAGE_TOOL, buildAgentMessageEnvelope } from "../agentMessage";
import { clearAllLinkedCache } from "../linkedConversations";
import { LinkedConversationsWidget } from "./LinkedConversationsWidget";

const SELF = "conv-self";

function conv(id: string, name: string, repoId = "repo-1"): Conversation {
  return { id, name, repoId, handle: null, pendingReminder: null } as unknown as Conversation;
}

function envelope(from: string, messageId: string, title: string): string {
  return buildAgentMessageEnvelope({ conversationId: from, title, repo: "old-repo", backend: "claude" }, messageId, "hi");
}

function send(id: string, to: string): NormalizedBlock {
  return { type: "tool_use", id, name: SEND_MESSAGE_TOOL, input: { conversation_id: to, text: "x" } } as unknown as NormalizedBlock;
}

function ok(json: Record<string, unknown>): JsonValue {
  return [{ type: "text", text: JSON.stringify(json) }] as unknown as JsonValue;
}

/** A session entry holding `users` (envelopes) then one assistant turn with `sends`. */
function entry(
  users: string[],
  sends: NormalizedBlock[] = [],
  results: Record<string, { content: JsonValue; isError?: boolean }> = {},
): SessionEntry {
  const turns: Record<string, unknown> = {};
  const timeline: Array<{ kind: "turn"; id: string }> = [];
  users.forEach((text, i) => {
    turns[`u${i}`] = { id: `u${i}`, role: "user", status: "final", streamingText: text, streamingThinking: "", blocks: [], parentToolUseId: null, hasThinking: false };
    timeline.push({ kind: "turn", id: `u${i}` });
  });
  if (sends.length) {
    turns.a0 = { id: "a0", role: "assistant", status: "final", streamingText: "", streamingThinking: "", blocks: sends, parentToolUseId: null, hasThinking: false };
    timeline.push({ kind: "turn", id: "a0" });
  }
  const toolResults: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(results)) {
    toolResults[id] = { toolUseId: id, content: r.content, isError: !!r.isError, parentToolUseId: null };
  }
  return { timeline, turns, toolResults, toolStartedAt: {} } as unknown as SessionEntry;
}

let container: HTMLDivElement;
let root: Root;
const select = vi.fn();

/** The header's reading (the only `wf-mono` capsule in the section's label). */
function meta(): string | null | undefined {
  return container.querySelector("[data-widget='linked'] .wf-mono")?.textContent;
}

/** An envelope from before message ids: its card carries no id to be found by. */
const NO_ID_ENVELOPE =
  "<flightdeck-message>\n<from>A</from>\n<from-conversation-id>conv-a</from-conversation-id>\n<body>\nhi\n</body>\n</flightdeck-message>";

function mount() {
  act(() => {
    root.render(createElement(LinkedConversationsWidget, { conv: conv(SELF, "Me") }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearAllLinkedCache();
  select.mockClear();
  useConversationsStore.setState({
    repos: [{ id: "repo-1", path: "/Users/me/Repos/tosse-code" }] as never,
    conversations: [conv(SELF, "Me"), conv("conv-a", "Auth refactor"), conv("conv-b", "Billing")],
    selectConversation: select,
  });
  useSidePanelLayout.getState().setCollapsed("linked", false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationStore.setState({ sessions: {} });
  useDisplay.setState({ panelAnimations: true });
});

describe("LinkedConversationsWidget", () => {
  it("renders nothing without a link", () => {
    useConversationStore.setState({ sessions: { [SELF]: entry(["just a prompt"]) } });
    mount();
    expect(container.innerHTML).toBe("");
  });

  it("lists partners newest first, by live name, with their figures", () => {
    useConversationStore.setState({
      sessions: {
        [SELF]: entry([envelope("conv-a", "m1", "Old auth title")], [send("t1", "conv-b")], {
          t1: { content: ok({ conversation_id: "conv-b", message_id: "m2" }) },
        }),
      },
    });
    mount();
    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Billing"),
      expect.stringContaining("Auth refactor"), // the live name wins over the snapshot
    ]);
    expect(rows[0].textContent).toContain("tosse-code");
    // The header's reading is the partner count — the capsule itself, not any « 2 » on the page.
    expect(meta()).toBe("2");
  });

  it("shows the exchange compactly — « created », both directions — and says it in words", () => {
    const createBlock = {
      type: "tool_use",
      id: "t1",
      name: CREATE_CONVERSATION_TOOL,
      input: { repo_path: "/r/billing", title: "Fix invoices", first_message: "Go" },
    } as unknown as NormalizedBlock;
    useConversationStore.setState({
      sessions: {
        [SELF]: entry([envelope("conv-b", "m7", "Billing")], [createBlock], {
          t1: {
            content: ok({ conversation_id: "conv-b", repo_path: "/r/billing", backend: "claude", started: true, message_id: "m5" }),
          },
        }),
      },
    });
    mount();
    const row = container.querySelector("li")!;
    expect(row.textContent).toContain("created");
    const open = row.querySelector("button")!;
    expect(open.getAttribute("aria-label")).toBe(
      "Open Billing (tosse-code) at the last message exchanged. " +
        "Created by this conversation · 1 message sent · 1 message received",
    );
    // No refusal, no « ! ».
    expect(row.querySelector("[aria-label*='refused']")).toBeNull();
  });

  it("a removed partner we only ever SENT to: an em dash on screen, never read aloud", () => {
    useConversationStore.setState({
      sessions: {
        [SELF]: entry([], [send("t1", "conv-deleted")], {
          t1: { content: ok({ conversation_id: "conv-deleted", message_id: "m2" }) },
        }),
      },
    });
    mount();
    const row = container.querySelector("li")!;
    expect(row.dataset.gone).toBeDefined();
    // A send records no recipient name or repo: both unknown, never invented.
    expect(row.textContent).toContain("—");
    expect(row.textContent).not.toContain("tosse-code");
    const here = row.querySelector("button")!;
    expect(here.getAttribute("aria-label")).toBe(
      "Show the last exchange with an unnamed conversation in this thread",
    );
    expect(row.querySelector("[aria-label^='an unnamed conversation, no longer']")).not.toBeNull();
  });

  it("keeps the reply slot on a row with nothing to scroll to, so the figures line up", () => {
    useConversationStore.setState({ sessions: { [SELF]: entry([NO_ID_ENVELOPE]) } });
    mount();
    const row = container.querySelector("li")!;
    const open = row.querySelector("button")!;
    // The row still opens the partner — just at no particular message.
    expect(open.getAttribute("aria-label")).toMatch(/^Open Auth refactor \(tosse-code\)\. /);
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(row.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
    act(() => open.click());
    expect(useThreadJump.getState().request).toMatchObject({ convId: "conv-a", anchor: null });
  });

  it("opens the partner at the matching message, and scrolls this thread from the side button", () => {
    useConversationStore.setState({
      sessions: {
        [SELF]: entry([], [send("t1", "conv-b")], { t1: { content: ok({ conversation_id: "conv-b", message_id: "m2" }) } }),
      },
    });
    mount();
    const [open, here] = Array.from(container.querySelectorAll("li button")) as HTMLButtonElement[];
    act(() => open.click());
    expect(useThreadJump.getState().request).toMatchObject({
      convId: "conv-b",
      anchor: { kind: "received", messageId: "m2" },
    });
    act(() => here.click());
    expect(useThreadJump.getState().request).toMatchObject({
      convId: SELF,
      anchor: { kind: "sentTool", toolUseId: "t1" },
    });
  });

  it("dims a removed partner: its snapshot name, no dot, no jump — the local one stays", () => {
    useConversationStore.setState({
      sessions: { [SELF]: entry([envelope("conv-gone", "m1", "Deleted one")]) },
    });
    mount();
    const row = container.querySelector("li")!;
    expect(row.dataset.gone).toBeDefined();
    expect(row.textContent).toContain("Deleted one");
    expect(row.textContent).toContain("old-repo");
    expect(row.querySelector(".wf-dot")).toBeNull();
    // Only the local « show here » button remains.
    expect(row.querySelectorAll("button")).toHaveLength(1);
  });

  it("flags refused sends next to a real exchange", () => {
    useConversationStore.setState({
      sessions: {
        [SELF]: entry([], [send("t1", "conv-b"), send("t2", "conv-b")], {
          t1: { content: ok({ conversation_id: "conv-b", message_id: "m2" }) },
          t2: { content: [{ type: "text", text: "Denied" }] as unknown as JsonValue, isError: true },
        }),
      },
    });
    mount();
    const fail = container.querySelector("[aria-label^='1 message to it was refused']");
    expect(fail?.textContent).toBe("!");
  });

  it("caps the list at five with a « Show N more » toggle", () => {
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    useConversationStore.setState({
      sessions: { [SELF]: entry(ids.map((id, i) => envelope(id, `m${i}`, id.toUpperCase()))) },
    });
    mount();
    expect(container.querySelectorAll("li")).toHaveLength(5);
    const more = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Show 2 more"))!;
    act(() => more.click());
    expect(container.querySelectorAll("li")).toHaveLength(7);
    expect(more.textContent).toContain("Show fewer");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    act(() => more.click());
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(more.textContent).toContain("Show 2 more");
  });

  it("gates its transitions on the panel-animations preference", () => {
    useConversationStore.setState({ sessions: { [SELF]: entry([envelope("conv-a", "m1", "A")]) } });
    act(() => useDisplay.setState({ panelAnimations: false }));
    mount();
    expect(container.querySelector("ul")!.hasAttribute("data-motion")).toBe(false);
    act(() => useDisplay.setState({ panelAnimations: true }));
    expect(container.querySelector("ul")!.hasAttribute("data-motion")).toBe(true);
  });

  it("folded: the rows are unmounted, the header keeps its count", () => {
    useConversationStore.setState({
      sessions: { [SELF]: entry([envelope("conv-a", "m1", "A")]) },
    });
    useSidePanelLayout.getState().setCollapsed("linked", true);
    mount();
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(meta()).toBe("1");
  });
});
