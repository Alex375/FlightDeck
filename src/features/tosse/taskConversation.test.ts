// The one product decision "Start" and "Discuss" do NOT share: whether a successful launch
// takes the window with it.
//
// It is locked here rather than left inline in the provider because the two buttons run
// through the SAME launch code — the conversation is created, linked and sent to either way
// — so the only thing telling them apart is this predicate. Both callers (the one-click
// path and the folder dialog) go through it, so a change here changes both or neither.

import { describe, expect, it } from "vitest";
import { launchFocusesConversation } from "./taskConversation";

describe("launchFocusesConversation", () => {
  it("stays on the tasks view when Start is pressed and the preference is on", () => {
    expect(launchFocusesConversation("pickup", true)).toBe(false);
  });

  it("follows Start to the conversation when the preference is off", () => {
    expect(launchFocusesConversation("pickup", false)).toBe(true);
  });

  // The asymmetry is the point, not an oversight: "Discuss" is a question, and its answer
  // is the reason to press it. The preference is about handing a task OFF, so it must not
  // silently swallow the one gesture that is waiting for a reply.
  it("always follows Discuss, whatever the preference says", () => {
    expect(launchFocusesConversation("discuss", true)).toBe(true);
    expect(launchFocusesConversation("discuss", false)).toBe(true);
  });
});
