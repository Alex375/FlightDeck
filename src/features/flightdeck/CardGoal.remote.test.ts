// `/goal` on a conversation running on a PAIRED SERVER. Goal state is disk-only (the transcript's
// `goal_status` lines), and that transcript is on the server: the seed a Flight Deck card does on
// mount, and the composer chip it feeds, must go through the read routed by CONVERSATION
// (`loadSessionGoal(convId, sessionId)` — the core runs the goal pre-filter on the server), so a
// goal set there shows here: the Flight Deck target and the composer chip alike.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadSessionGoal: vi.fn() }));

vi.mock("../../ipc/client", () => ({
  commands: { loadSessionGoal: mocks.loadSessionGoal },
  events: {},
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConversationsStore } from "../../store/conversationsStore";
import { useGoalStore } from "../../store/goalStore";
import { GoalChip } from "../conversation/GoalChip";
import { CardGoal } from "./CardGoal";

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const GOAL = { condition: "every remote read is routed", reason: "2 surfaces left" };

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => {});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useGoalStore.getState().clearAll();
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [{ id: "r1", path: "/srv/app", machineId: "m1" }] as never,
    conversations: [{ id: "c-remote", repoId: "r1", name: "remote", kind: "claude", sessionId: "sid-1" }] as never,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/goal on a conversation running on a paired server", () => {
  it("the Flight Deck card seeds the goal through the routed read and shows the target; the composer chip follows", async () => {
    mocks.loadSessionGoal.mockResolvedValue(ok(GOAL));
    act(() => {
      root.render(
        createElement("div", null, createElement(CardGoal, { convId: "c-remote" }), createElement(GoalChip, { convId: "c-remote" })),
      );
    });
    await flush();
    // Routed by the conversation: the core reads the SERVER's transcript for it.
    expect(mocks.loadSessionGoal).toHaveBeenCalledWith("c-remote", "sid-1");
    expect(mocks.loadSessionGoal).toHaveBeenCalledTimes(1);
    expect(useGoalStore.getState().byConv["c-remote"]).toEqual(GOAL);
    // The Flight Deck target and the composer chip both render.
    expect(container.querySelector(".ag-goal")).not.toBeNull();
    expect(container.querySelector(".cv-goal-chip")).not.toBeNull();
  });

  it("an unreachable server leaves the last known goal in place (the next turn edge retries)", async () => {
    useGoalStore.getState().set("c-remote", GOAL);
    mocks.loadSessionGoal.mockResolvedValue({
      status: "error",
      error: { kind: "unreachable", server: "Target", reason: "could not reach the server" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { refreshActiveGoal } = await import("../../store/goalStore");
      await refreshActiveGoal("c-remote", "sid-1");
      expect(useGoalStore.getState().byConv["c-remote"]).toEqual(GOAL);
      // Never silent: the failure is logged with the server's name.
      expect(errSpy).toHaveBeenCalledWith("loadSessionGoal failed:", "couldn't reach Target — could not reach the server");
    } finally {
      errSpy.mockRestore();
    }
  });
});
