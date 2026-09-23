import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({
  commands: { applySessionPermissions: vi.fn() },
}));

import { commands } from "../ipc/client";
import {
  applyConvToolPermissions,
  clearConvToolPermissions,
  convToolRules,
  sessionRulesFor,
  useConvToolPermissions,
} from "./convToolPermissions";

const SEND = "mcp__claude_ai_Gmail__send_message";
const SLACK = "mcp__claude_ai_Slack__slack_send_message";
const apply = vi.mocked(commands.applySessionPermissions);

beforeEach(() => {
  localStorage.clear();
  useConvToolPermissions.setState({ byConv: {} });
  apply.mockReset();
});

describe("a conversation's own tool rules", () => {
  it("without a running session: kept, and handed to the next spawn", async () => {
    await applyConvToolPermissions("c1", null, [{ tool: SEND, kind: "deny" }]);
    expect(apply).not.toHaveBeenCalled();
    expect(sessionRulesFor("c1")).toEqual({ allow: [], ask: [], deny: [SEND] });
    expect(sessionRulesFor("c2")).toBeNull();
  });

  it("with one: pushes the WHOLE new set to the session, then keeps it", async () => {
    apply.mockResolvedValue({ status: "ok", data: null });
    await applyConvToolPermissions("c1", null, [{ tool: SEND, kind: "deny" }]);
    await applyConvToolPermissions("c1", "session-1", [{ tool: SLACK, kind: "ask" }]);
    expect(apply).toHaveBeenCalledWith("session-1", { allow: [], ask: [SLACK], deny: [SEND] });
    expect(sessionRulesFor("c1")).toEqual({ allow: [], ask: [SLACK], deny: [SEND] });
  });

  it("a refused change is NOT kept — the panel never shows a rule the session isn't under", async () => {
    apply.mockResolvedValue({ status: "error", error: "nope" });
    await expect(applyConvToolPermissions("c1", "session-1", [{ tool: SEND, kind: "deny" }])).rejects.toThrow(/nope/);
    expect(sessionRulesFor("c1")).toBeNull();
  });

  it("back to Default removes the rule; the last one removed clears the conversation", async () => {
    await applyConvToolPermissions("c1", null, [{ tool: SEND, kind: "deny" }]);
    await applyConvToolPermissions("c1", null, [{ tool: SEND, kind: null }]);
    expect(useConvToolPermissions.getState().byConv).toEqual({});
  });

  it("persists across a reload, and is dropped with its conversation", async () => {
    await applyConvToolPermissions("c1", null, [{ tool: SEND, kind: "ask" }]);
    expect(JSON.parse(localStorage.getItem("tosse:convToolPerms")!)).toEqual({ c1: { [SEND]: "ask" } });
    expect(convToolRules(useConvToolPermissions.getState().byConv, "c1")).toEqual([
      { rule: SEND, kind: "ask", source: "conversation", path: "" },
    ]);
    clearConvToolPermissions("c1");
    expect(sessionRulesFor("c1")).toBeNull();
  });
});
