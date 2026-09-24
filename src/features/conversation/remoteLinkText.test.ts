import { describe, expect, it } from "vitest";
import { remoteLinkText } from "./remoteLinkText";

describe("remoteLinkText", () => {
  it("is null for a local session (no link state at all)", () => {
    expect(remoteLinkText(null)).toBeNull();
    expect(remoteLinkText(undefined)).toBeNull();
  });

  it("says Connecting for a never-yet-attached actor", () => {
    expect(remoteLinkText({ kind: "connecting" })).toBe("Connecting to the server…");
  });

  it("says Reconnecting once the link has attached before, regardless of the attempt number", () => {
    expect(remoteLinkText({ kind: "reconnecting", attempt: 0 })).toBe("Reconnecting to the server…");
    expect(remoteLinkText({ kind: "reconnecting", attempt: 7 })).toBe("Reconnecting to the server…");
  });
});
