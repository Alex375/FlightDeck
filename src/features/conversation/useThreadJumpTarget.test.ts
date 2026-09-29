// Mounts the receiving half of a jump against a hand-built thread DOM: the `sentTool` anchor
// (a messaging card by its OWN tool_use id — how the side panel's "Linked conversations" widget
// scrolls its own thread) must find the card, open the clean-output fold that hides it, and give
// up with a note that says what was missing. The message-id `sent` anchor shares the same card
// lookup, so it is pinned here too.
//
// Frames are driven by hand (a stubbed requestAnimationFrame) and the clock is stubbed, so each
// step of the frame loop is observable. Built with createElement in a `*.test.ts` file, same
// discipline as the other mounted tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { JsonValue } from "../../ipc/client";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { JUMP_TIMEOUT_MS, openConversationAt, useThreadJump } from "../../store/threadJump";
import type { SessionEntry } from "../../store/types";
import { useToasts } from "../../store/toasts";
import { useWorkFold } from "../../store/workFold";
import { useThreadJumpTarget } from "./useThreadJumpTarget";

const CONV = "c-jump";

let frames: FrameRequestCallback[] = [];
let now = 1000;
let container: HTMLDivElement;
let root: Root;
let thread: HTMLDivElement | null = null;
const release = vi.fn();

/** Run the frames queued so far (the loop re-queues itself for the next call). */
function frame() {
  const due = frames;
  frames = [];
  act(() => due.forEach((cb) => cb(now)));
}

/** A pane with an EMPTY scroll element React never touches, so the test owns its children. */
function Pane() {
  const ref = useRef<HTMLDivElement | null>(null);
  useThreadJumpTarget(CONV, ref, release);
  return createElement("div", {
    ref: (el: HTMLDivElement | null) => {
      ref.current = el;
      thread = el;
    },
  });
}

function add(html: string) {
  thread!.insertAdjacentHTML("beforeend", html);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = [];
  now = 1000;
  release.mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
  useConversationsStore.setState({ selectConversation: vi.fn() });
  useThreadJump.setState({ request: null });
  useToasts.setState({ toasts: [] });
  useWorkFold.getState().clearAll();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(Pane)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  thread = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useConversationStore.setState({ sessions: {} });
});

describe("useThreadJumpTarget — sentTool", () => {
  it("finds the card by its tool_use id, flashes it, then settles", () => {
    add(`<div data-agent-msg-sent="toolu_other"></div><div data-agent-msg-sent="toolu_1"></div>`);
    act(() => openConversationAt(CONV, { kind: "sentTool", toolUseId: "toolu_1" }));
    frame();
    const card = thread!.querySelector<HTMLElement>("[data-agent-msg-sent='toolu_1']")!;
    expect(card.dataset.jumpFlash).toBe("1");
    expect(thread!.querySelector<HTMLElement>("[data-agent-msg-sent='toolu_other']")!.dataset.jumpFlash).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    // Held in place for a moment, then the request is done with.
    now += 1000;
    frame();
    expect(useThreadJump.getState().request).toBeNull();
  });

  it("opens the clean-output fold that hides the card, then lands on it once mounted", () => {
    // A closed fold does not mount its children: it only stamps their ids on itself.
    add(`<div data-jump-anchors="toolu_0 toolu_1" data-fold-key="round-3"></div>`);
    act(() => openConversationAt(CONV, { kind: "sentTool", toolUseId: "toolu_1" }));
    frame();
    expect(useWorkFold.getState().open[CONV]?.["round-3"]).toBe(true);
    expect(release).not.toHaveBeenCalled();
    // The fold opened: its card renders on a later frame.
    add(`<div data-agent-msg-sent="toolu_1"></div>`);
    frame();
    expect(thread!.querySelector<HTMLElement>("[data-agent-msg-sent='toolu_1']")!.dataset.jumpFlash).toBe("1");
  });

  it("does not open a fold that holds only OTHER cards", () => {
    add(`<div data-jump-anchors="toolu_10" data-fold-key="round-1"></div>`);
    act(() => openConversationAt(CONV, { kind: "sentTool", toolUseId: "toolu_1" }));
    frame();
    expect(useWorkFold.getState().open[CONV]?.["round-1"]).toBeUndefined();
  });

  it("gives up after the deadline with a note naming what was missing", () => {
    act(() => openConversationAt(CONV, { kind: "sentTool", toolUseId: "toolu_missing" }));
    frame();
    expect(useToasts.getState().toasts).toHaveLength(0);
    now += JUMP_TIMEOUT_MS + 1;
    frame();
    expect(useThreadJump.getState().request).toBeNull();
    expect(useToasts.getState().toasts.map((t) => ("text" in t ? t.text : null))).toEqual([
      "Couldn't find that exchange in this conversation.",
    ]);
    // Settled: the loop stopped.
    expect(frames).toHaveLength(0);
  });

  it("ignores a request for another conversation", () => {
    add(`<div data-agent-msg-sent="toolu_1"></div>`);
    act(() => openConversationAt("someone-else", { kind: "sentTool", toolUseId: "toolu_1" }));
    expect(frames).toHaveLength(0);
    expect(useThreadJump.getState().request?.convId).toBe("someone-else");
  });
});

describe("useThreadJumpTarget — sent (by message id), through the shared card lookup", () => {
  it("resolves the message id to its send card through the echoed result", () => {
    const content = [
      { type: "text", text: JSON.stringify({ conversation_id: "c-b", delivered: true, message_id: "m-42" }) },
    ] as unknown as JsonValue;
    useConversationStore.setState({
      sessions: {
        [CONV]: {
          toolResults: { toolu_7: { toolUseId: "toolu_7", content, isError: false, parentToolUseId: null } },
        } as unknown as SessionEntry,
      },
    });
    add(`<div data-agent-msg-sent="toolu_7"></div>`);
    act(() => openConversationAt(CONV, { kind: "sent", messageId: "m-42" }));
    frame();
    expect(thread!.querySelector<HTMLElement>("[data-agent-msg-sent='toolu_7']")!.dataset.jumpFlash).toBe("1");
  });
});
