import { describe, expect, it, vi } from "vitest";
import { useConversationsStore } from "./conversationsStore";
import {
  JUMP_TIMEOUT_MS,
  jumpMissNote,
  jumpRequestExpired,
  openConversationAt,
  useThreadJump,
  type JumpRequest,
} from "./threadJump";

const request = (at: number): JumpRequest => ({
  convId: "c1",
  anchor: { kind: "received", messageId: "m1" },
  nonce: 1,
  at,
});

describe("jumpRequestExpired", () => {
  it("keeps a request alive while its target may still be loading", () => {
    expect(jumpRequestExpired(request(1000), 1000)).toBe(false);
    expect(jumpRequestExpired(request(1000), 1000 + JUMP_TIMEOUT_MS)).toBe(false);
  });

  it("kills a request nobody settled once the deadline from the click has passed", () => {
    // The pane was left before the target rendered: reopening that conversation later must
    // not replay the jump (nor report a miss out of nowhere).
    expect(jumpRequestExpired(request(1000), 1001 + JUMP_TIMEOUT_MS)).toBe(true);
  });
});

describe("jumpMissNote", () => {
  it("names what was looked for, per anchor kind", () => {
    expect(jumpMissNote({ kind: "received", messageId: "m" })).toBe(
      "Couldn't find that message in this conversation.",
    );
    expect(jumpMissNote({ kind: "sent", messageId: "m" })).toBe(
      "Couldn't find where that message was sent in this conversation.",
    );
    expect(jumpMissNote({ kind: "artifact", toolUseId: "t" })).toBe(
      "Couldn't find where that version was published in this conversation.",
    );
  });

  it("stays true to a tool_use-addressed card, which may be a creation rather than a send", () => {
    expect(jumpMissNote({ kind: "sentTool", toolUseId: "t" })).toBe(
      "Couldn't find that exchange in this conversation.",
    );
  });
});

describe("openConversationAt", () => {
  it("selects the conversation and records a sentTool request with a fresh nonce", () => {
    const select = vi.fn();
    useConversationsStore.setState({ selectConversation: select });
    openConversationAt("c1", { kind: "sentTool", toolUseId: "toolu_1" });
    const first = useThreadJump.getState().request;
    expect(select).toHaveBeenCalledWith("c1");
    expect(first).toMatchObject({ convId: "c1", anchor: { kind: "sentTool", toolUseId: "toolu_1" } });
    // A second click on the same target must scroll again: a new nonce, a new request.
    openConversationAt("c1", { kind: "sentTool", toolUseId: "toolu_1" });
    expect(useThreadJump.getState().request!.nonce).toBeGreaterThan(first!.nonce);
    // Settling an OLD nonce leaves the newer request alone.
    useThreadJump.getState().settle(first!.nonce);
    expect(useThreadJump.getState().request).not.toBeNull();
  });
});
