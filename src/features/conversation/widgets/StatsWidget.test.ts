// The Stats widget, rendered for real: what reaches the screen for each state of the store, and
// its COST contract — nothing for a brand-new conversation, « — » (never 0) for an unknown total,
// a folded section that keeps only its header's reading, a value that rolls in only when it
// changes (and only when motion is allowed), and NO re-render when the core re-pushes the same
// session total (it does so on every model call). What each figure and caption MEANS is pinned
// by stats.test.ts; the checks here only prove the right state landed.
//
// Rendered through react-dom/client rather than the server renderer: the zustand stores are read
// through subscriptions the SSR path only sees at their initial state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStatePayload, SessionUsage } from "../../../ipc/client";
import { useConversationStore } from "../../../store/conversationStore";
import type { Conversation } from "../../../store/conversationsStore";
import { useDisplay } from "../../../store/display";
import { useSidePanelLayout } from "../../../store/sidePanelWidgetsStore";
import { StatsWidget } from "./StatsWidget";

const ID = "stats-widget-conv";
// The widget reads the id and the backend only.
const conv = { id: ID, kind: "claude" } as Conversation;

let container: HTMLDivElement;
let root: Root;
let commits = 0;

function usage(output: number): SessionUsage {
  // A fresh object each time: the core deserializes a new one per state push.
  return {
    total: { input: 9_342, cache_creation: 29_575_869, cache_read: 557_154_864, output },
    cost_usd: 412.5,
    per_model: [],
  };
}

function push(u: SessionUsage | null, over: Partial<SessionStatePayload> = {}) {
  const state: SessionStatePayload = {
    busy: false,
    session_id: null,
    cwd: null,
    model: null,
    permission_mode: null,
    output_style: null,
    effort: null,
    ultracode: false,
    activity: null,
    awaiting_permission: false,
    retry: null,
    link: null,
    ended: false,
    context_tokens: null,
    context_window: null,
    context_usage: null,
    rate_limit: null,
    session_usage: u,
    ...over,
  };
  act(() => useConversationStore.getState().applyState(ID, state));
}

/** Give the conversation a thread (one settled turn), as a loaded history or a first message
 *  would. */
function withThread() {
  act(() => {
    useConversationStore.getState().ensureSession(ID);
    useConversationStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [ID]: { ...s.sessions[ID], timeline: [{ kind: "turn", id: "t1" }] as never },
      },
    }));
  });
}

function render() {
  act(() => {
    root.render(
      createElement(Profiler, { id: "stats", onRender: () => void (commits += 1) }, createElement(StatsWidget, { conv })),
    );
  });
}

/** The header's capsule reading. */
const meta = () => container.querySelector("section .wf-mono")?.textContent ?? null;
/** A tile by its caption (the tile's accessible label starts with it). */
const tile = (label: string) => container.querySelector<HTMLElement>(`[aria-label^="${label}:"]`);
/** A tile's value node (the first child: the rolling value). */
const value = (label: string) => tile(label)?.firstElementChild as HTMLElement | null | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  commits = 0;
  useConversationStore.getState().dropSession(ID);
  useSidePanelLayout.getState().setCollapsed("stats", false);
  useDisplay.setState({ panelAnimations: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConversationStore.getState().dropSession(ID);
  useSidePanelLayout.getState().setCollapsed("stats", false);
  useDisplay.setState({ panelAnimations: true });
});

describe("StatsWidget", () => {
  it("renders nothing for a brand-new conversation — no thread, no total", () => {
    render();
    expect(container.innerHTML).toBe("");
  });

  it("reads « — » for a total not known yet, never 0, with the four tiles below", () => {
    withThread();
    render();
    expect(meta()).toBe("—");
    expect(value("Tokens")?.textContent).toBe("—");
    expect(value("Tokens")?.hasAttribute("data-unknown")).toBe(true);
    expect(value("Avg turn")?.textContent).toBe("—");
    expect(tile("Files")).not.toBeNull();
    expect(tile("Calls")).not.toBeNull();
  });

  it("puts the session total in the header, compact, and in the Tokens tile", () => {
    withThread();
    push(usage(4_868_160));
    render();
    expect(meta()).toBe("592M");
    expect(value("Tokens")?.textContent).toBe("592M");
    expect(tile("Tokens")?.textContent).toContain("94% cached");
  });

  it("folded: the header keeps its reading, the tiles are gone", () => {
    withThread();
    push(usage(4_868_160));
    act(() => useSidePanelLayout.getState().setCollapsed("stats", true));
    render();
    expect(meta()).toBe("592M");
    expect(tile("Tokens")).toBeNull();
    expect(tile("Avg turn")).toBeNull();
  });

  it("does not re-render when a state push repeats the same total", () => {
    withThread();
    push(usage(4_868_160));
    render();
    const before = commits;
    // What the core does on every model call: the whole state again, the total a NEW object.
    push(usage(4_868_160), { busy: true });
    push(usage(4_868_160), { busy: true, context_tokens: 180_000 });
    expect(commits).toBe(before);
    // A real change does reach the screen.
    push(usage(9_000_000));
    expect(commits).toBeGreaterThan(before);
    expect(meta()).toBe("596M");
  });

  it("rolls a value in only once it changes, and only when motion is allowed", () => {
    withThread();
    push(usage(4_868_160));
    act(() => useDisplay.setState({ panelAnimations: true }));
    render();
    const grid = tile("Tokens")?.parentElement;
    expect(grid?.hasAttribute("data-motion")).toBe(true);
    // The value the panel opened with does not animate.
    expect(value("Tokens")?.hasAttribute("data-roll")).toBe(false);
    push(usage(9_000_000));
    expect(value("Tokens")?.textContent).toBe("596M");
    expect(value("Tokens")?.hasAttribute("data-roll")).toBe(true);
    // Motion switched off: the roll is flagged but nothing scopes an animation to it.
    act(() => useDisplay.setState({ panelAnimations: false }));
    expect(tile("Tokens")?.parentElement?.hasAttribute("data-motion")).toBe(false);
  });
});
