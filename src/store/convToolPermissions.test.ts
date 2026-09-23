import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({
  commands: { applySessionOverrides: vi.fn() },
}));

import { commands } from "../ipc/client";
import {
  applyConvOverrides,
  clearConvToolPermissions,
  convPluginSay,
  convToolRules,
  sessionOverridesFor,
  useConvToolPermissions,
} from "./convToolPermissions";

const SEND = "mcp__claude_ai_Gmail__send_message";
const SLACK = "mcp__claude_ai_Slack__slack_send_message";
const PLUGIN = "tosse-workflow@tosse-plugins";
const apply = vi.mocked(commands.applySessionOverrides);
const none = { allow: [], ask: [], deny: [], enabled_plugins: {} };

beforeEach(() => {
  localStorage.clear();
  useConvToolPermissions.setState({ byConv: {} });
  apply.mockReset();
});

describe("a conversation's own extension settings", () => {
  it("without a running session: kept, and handed to the next spawn", async () => {
    await applyConvOverrides("c1", null, [{ tool: SEND, kind: "deny" }]);
    expect(apply).not.toHaveBeenCalled();
    expect(sessionOverridesFor("c1")).toEqual({ ...none, deny: [SEND] });
    expect(sessionOverridesFor("c2")).toBeNull();
  });

  it("with one: pushes the WHOLE new set, reloading plugins only when a plugin changed", async () => {
    apply.mockResolvedValue({ status: "ok", data: null });
    await applyConvOverrides("c1", null, [{ tool: SEND, kind: "deny" }]);
    await applyConvOverrides("c1", "session-1", [{ tool: SLACK, kind: "ask" }]);
    expect(apply).toHaveBeenLastCalledWith("session-1", { ...none, ask: [SLACK], deny: [SEND] }, false);
    await applyConvOverrides("c1", "session-1", [], [{ id: PLUGIN, enabled: false }]);
    expect(apply).toHaveBeenLastCalledWith(
      "session-1",
      { ...none, ask: [SLACK], deny: [SEND], enabled_plugins: { [PLUGIN]: false } },
      true,
    );
  });

  it("a refused change is NOT kept — the panel never shows a setting the session isn't under", async () => {
    apply.mockResolvedValue({ status: "error", error: "nope" });
    await expect(applyConvOverrides("c1", "session-1", [{ tool: SEND, kind: "deny" }])).rejects.toThrow(/nope/);
    expect(sessionOverridesFor("c1")).toBeNull();
  });

  it("back to Default removes the setting; the last one removed clears the conversation", async () => {
    await applyConvOverrides("c1", null, [{ tool: SEND, kind: "deny" }], [{ id: PLUGIN, enabled: true }]);
    await applyConvOverrides("c1", null, [{ tool: SEND, kind: null }], [{ id: PLUGIN, enabled: null }]);
    expect(useConvToolPermissions.getState().byConv).toEqual({});
  });

  it("persists, reads back as resolution inputs, and is dropped with its conversation", async () => {
    await applyConvOverrides("c1", null, [{ tool: SEND, kind: "ask" }], [{ id: PLUGIN, enabled: false }]);
    expect(JSON.parse(localStorage.getItem("tosse:convToolPerms")!)).toEqual({
      c1: { rules: { [SEND]: "ask" }, plugins: { [PLUGIN]: false } },
    });
    const byConv = useConvToolPermissions.getState().byConv;
    expect(convToolRules(byConv, "c1")).toEqual([{ rule: SEND, kind: "ask", source: "conversation", path: "" }]);
    expect(convPluginSay(byConv, "c1", PLUGIN)).toEqual([{ source: "conversation", enabled: false }]);
    clearConvToolPermissions("c1");
    expect(sessionOverridesFor("c1")).toBeNull();
  });
});
