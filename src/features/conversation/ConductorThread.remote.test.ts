// Rewind / fork on a conversation running on a PAIRED SERVER: both cut or copy the transcript on
// THIS Mac's disk, and that conversation's transcript is on the server. The hover controls are not
// offered there, and nothing shows in their place. A local conversation keeps its controls.
//
// Mounts the real ConductorThread against seeded stores (as cleanFoldIdentity.test.ts does).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConductorThread } from "./ConductorThread";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useDisplay } from "../../store/display";
import type { SessionStatePayload } from "../../ipc/client";
import type { SessionEntry, Turn } from "../../store/types";

let container: HTMLDivElement;
let root: Root;

const turn = (id: string, role: "user" | "assistant", text: string): Turn =>
  ({
    id,
    role,
    status: "done",
    streamingText: role === "user" ? text : "",
    streamingThinking: "",
    blocks: role === "assistant" ? [{ type: "text", text }] : [],
    parentToolUseId: null,
    hasThinking: false,
  }) as unknown as Turn;

/** Two exchanges, settled: u1 → a1 → u2 → a2. */
function seedThread(session: string) {
  const turns = {
    u1: turn("u1", "user", "first"),
    a1: turn("a1", "assistant", "one"),
    u2: turn("u2", "user", "second"),
    a2: turn("a2", "assistant", "two"),
  };
  const entry = {
    session,
    state: { busy: false, awaiting_permission: false } as unknown as SessionStatePayload,
    timeline: ["u1", "a1", "u2", "a2"].map((id) => ({ kind: "turn", id })),
    turns,
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: {},
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    bgAgentIds: [],
    wakes: {},
    todos: [],
    toolDurations: {},
    toolStartedAt: {},
    thinkingDurations: {},
    markers: [],
  } as unknown as SessionEntry;
  act(() => {
    useConversationStore.setState((s) => ({ sessions: { ...s.sessions, [session]: entry } }));
  });
}

function render(session: string) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(ConductorThread, { session, scrollRef: () => {}, onRender: () => {} }),
      ),
    );
  });
}

const forkButtons = () => container.querySelectorAll('[aria-label="Fork a new conversation from here"]');
const rewindButtons = () => container.querySelectorAll('[aria-label="Resume the conversation from here"]');
const actionRows = () => container.querySelectorAll(".cv-msg-actions");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useDisplay.getState().set({ messageControls: true, cleanOutput: false });
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Base" }] as never,
    repos: [
      { id: "r-remote", path: "/srv/app", addedAt: 1, machineId: "m1" },
      { id: "r-local", path: "/Users/me/app", addedAt: 1, machineId: null },
    ],
    conversations: [
      { id: "c-remote", repoId: "r-remote", kind: "claude", name: "remote" },
      { id: "c-local", repoId: "r-local", kind: "claude", name: "local" },
    ] as never,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationStore.setState({ sessions: {} });
});

describe("message controls on a conversation running on a paired server", () => {
  it("offers no rewind or fork, and shows nothing in their place", () => {
    seedThread("c-remote");
    render("c-remote");
    expect(forkButtons()).toHaveLength(0);
    expect(rewindButtons()).toHaveLength(0);
    expect(actionRows()).toHaveLength(0);
  });

  it("a local conversation keeps its controls", () => {
    seedThread("c-local");
    render("c-local");
    expect(forkButtons().length).toBe(3);
    // a1 (a prompt follows it) + u2 (not the first prompt).
    expect(rewindButtons().length).toBe(2);
  });
});
