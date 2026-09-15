import { describe, expect, it } from "vitest";
import { JUMP_TIMEOUT_MS, jumpRequestExpired, type JumpRequest } from "./threadJump";

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
