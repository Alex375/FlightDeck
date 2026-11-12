// Approving a plan on this Mac switches the conversation to Auto — but only once claude has
// TAKEN that approval (the plan's tool_result reads "approved"). A remote conversation's
// approval may never be used: the phone's rejection won the race, the held answer was dropped
// at reattach, or claude withdrew the prompt. Switching on the click (the IPC queued the answer)
// left plan mode without an approved plan.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/client", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => ({ status: "ok", data: null })) }),
  events: {},
}));

import type { ConversationItem } from "../../ipc/client";
import { useConversationStore } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { forgetPlanApproval, switchToAutoOnceApproved } from "./planApproval";

const S = "c1";

function seed() {
  useConversationStore.setState({ sessions: {} });
  useConversationsStore.setState({
    conversations: [{ id: S, repoId: "r1", cwd: "/srv", name: "c", kind: "claude", handle: null, permissionMode: "plan" }] as never,
  });
}

const result = (toolUseId: string, text: string, isError: boolean): ConversationItem =>
  ({ kind: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError, parent_tool_use_id: null }) as ConversationItem;

const mode = () => useConversationsStore.getState().conversations.find((c) => c.id === S)!.permissionMode;

beforeEach(() => {
  seed();
  forgetPlanApproval(S, "plan1");
});

describe("switching to Auto after a plan approval", () => {
  it("switches once the plan's result reads approved", () => {
    switchToAutoOnceApproved(S, "plan1");
    expect(mode()).toBe("plan");
    useConversationStore.getState().applyItem(S, result("plan1", "User has approved your plan. You can now start coding.", false));
    expect(mode()).toBe("auto");
  });

  it("does not switch when the plan was rejected (the phone's answer won, or the approval was dropped)", () => {
    switchToAutoOnceApproved(S, "plan1");
    useConversationStore.getState().applyItem(S, result("plan1", "Don't touch the schema.", true));
    expect(mode()).toBe("plan");
    // A later result of the same id (a replay re-delivering it) changes nothing either.
    useConversationStore.getState().applyItem(S, result("plan1", "User has approved your plan.", false));
    expect(mode()).toBe("plan");
  });

  it("does not switch while no result came (the prompt was withdrawn)", () => {
    switchToAutoOnceApproved(S, "plan1");
    useConversationStore.getState().applyItem(S, result("other", "User has approved your plan.", false));
    expect(mode()).toBe("plan");
  });

  it("does not switch for an approval whose send failed", () => {
    switchToAutoOnceApproved(S, "plan1");
    forgetPlanApproval(S, "plan1");
    useConversationStore.getState().applyItem(S, result("plan1", "User has approved your plan.", false));
    expect(mode()).toBe("plan");
  });
});
