// The clean-output fold must keep its DOM IDENTITY across the live → settled transition.
//
// This is the invariant `CleanBlocks` was built around ("live → settled is just a prop change
// here, not a remount"), and the exit choreography nearly destroyed it: the animation wrapper
// was rendered ONLY while the round was live, so at the moment the answer arrived every child
// of an open fold changed element type at a stable key. React then tears the subtree down and
// rebuilds it — every expanded `ToolSection` and step row snaps shut, and a sub-agent transcript
// already fetched is thrown away. Same thing on every permission prompt, which flips `live`
// twice in a row.
//
// The pure-logic tests in cleanExit.test.ts CANNOT see this: it only exists once the real
// components render. So this mounts the real ConductorThread against a seeded store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConductorThread } from "./ConductorThread";
import { useConversationStore } from "../../store/conversationStore";
import { useDisplay } from "../../store/display";
import { useWorkFold } from "../../store/workFold";
import type { NormalizedBlock, SessionStatePayload } from "../../ipc/client";
import type { SessionEntry, Turn } from "../../store/types";

const SESSION = "conv-fold-identity";
const TURN = "a1";

let container: HTMLDivElement;
let root: Root;

function blocks(): NormalizedBlock[] {
  return [
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
    { type: "tool_use", id: "t2", name: "Read", input: { file_path: "b.ts" } },
    { type: "tool_use", id: "t3", name: "Read", input: { file_path: "c.ts" } },
    { type: "tool_use", id: "t4", name: "Edit", input: { file_path: "d.ts" } },
    { type: "text", text: "Done." },
  ] as NormalizedBlock[];
}

/** A round whose work has all settled (every tool has a result) — so the fold holds work and
 *  the closing prose stays in clear, on both sides of the live flag. */
function seed(busy: boolean) {
  const turn = {
    id: TURN,
    role: "assistant",
    status: "streaming",
    streamingText: "",
    streamingThinking: "",
    blocks: blocks(),
    parentToolUseId: null,
    hasThinking: false,
  } as Turn;
  const entry = {
    session: SESSION,
    state: { busy, awaiting_permission: false } as unknown as SessionStatePayload,
    timeline: [{ kind: "turn", id: TURN }],
    turns: { [TURN]: turn },
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: Object.fromEntries(
      ["t1", "t2", "t3", "t4"].map((id) => [id, { content: "ok", isError: false }]),
    ),
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    bgAgentIds: [],
    todos: [],
    toolDurations: {},
    toolStartedAt: {},
    thinkingDurations: {},
    markers: [],
  } as unknown as SessionEntry;
  act(() => {
    useConversationStore.setState((s) => ({ sessions: { ...s.sessions, [SESSION]: entry } }));
  });
}

function render() {
  act(() => {
    root.render(
      createElement(ConductorThread, {
        session: SESSION,
        scrollRef: () => {},
        onRender: () => {},
      }),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useDisplay.getState().set({ cleanOutput: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDisplay.getState().set({ cleanOutput: false });
  useWorkFold.setState({ open: {} });
  useConversationStore.setState((s) => {
    const sessions = { ...s.sessions };
    delete sessions[SESSION];
    return { sessions };
  });
});

describe("clean-output fold identity", () => {
  it("does not remount the open fold's contents when the round settles", () => {
    seed(true);
    render();

    // Open the fold the way the user would.
    const header = container.querySelector<HTMLButtonElement>(".cv-work-h");
    expect(header).not.toBeNull();
    act(() => header!.click());

    const section = container.querySelector(".cv-steps");
    expect(section).not.toBeNull();
    // Expand a run inside the fold — this local state is exactly what a remount destroys.
    const runHeader = section!.querySelector<HTMLButtonElement>(".cv-steps-h");
    act(() => runHeader!.click());
    expect(section!.querySelector(".cv-steps-b")).not.toBeNull();

    // The turn finishes.
    seed(false);
    render();

    // The very same node, still expanded: a prop change, not a rebuild.
    expect(container.querySelector(".cv-steps")).toBe(section);
    expect(section!.querySelector(".cv-steps-b")).not.toBeNull();
  });

  it("survives the double flip a permission prompt causes mid-turn", () => {
    seed(true);
    render();
    act(() => container.querySelector<HTMLButtonElement>(".cv-work-h")!.click());
    const section = container.querySelector(".cv-steps");
    act(() => section!.querySelector<HTMLButtonElement>(".cv-steps-h")!.click());

    // `live` is `busy && !awaiting && streaming`, so a permission prompt turns it off and back
    // on without the round ever ending.
    act(() => {
      useConversationStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [SESSION]: {
            ...s.sessions[SESSION],
            state: { busy: true, awaiting_permission: true } as unknown as SessionStatePayload,
          },
        },
      }));
    });
    render();
    seed(true);
    render();

    expect(container.querySelector(".cv-steps")).toBe(section);
    expect(section!.querySelector(".cv-steps-b")).not.toBeNull();
  });
});
