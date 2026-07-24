import { describe, it, expect } from "vitest";
import { parseSkillInvocation, parseSlashCommand, userMessagePreviewText } from "./userText";

describe("parseSlashCommand", () => {
  it("extracts a bare command (with and without args)", () => {
    expect(
      parseSlashCommand(
        "<command-message>clear</command-message>\n<command-name>/clear</command-name>\n<command-args></command-args>",
      ),
    ).toEqual({ command: "/clear", args: "" });

    expect(
      parseSlashCommand(
        "<command-name>/pickup</command-name><command-args>abc-123</command-args>",
      ),
    ).toEqual({ command: "/pickup", args: "abc-123" });
  });

  it("prefixes a slash when the wrapped name lacks one", () => {
    expect(parseSlashCommand("<command-name>tosse-workflow:list-tasks</command-name>")).toEqual({
      command: "/tosse-workflow:list-tasks",
      args: "",
    });
  });

  it("returns null for a normal prompt", () => {
    expect(parseSlashCommand("just fix the login bug please")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  // A command reaches the thread in TWO shapes: as the user typed it (the optimistic bubble
  // appended on send) and CLI-wrapped (read back from the transcript). Both must produce the
  // same chip, or one command renders as grey raw text live and as a chip after a reload.
  it("reads the bare shape (as typed), so live matches reload", () => {
    expect(parseSlashCommand("/compact")).toEqual({ command: "/compact", args: "" });
    expect(parseSlashCommand("/land now")).toEqual({ command: "/land", args: "now" });
    expect(parseSlashCommand("/tosse-workflow:pickup")).toEqual({
      command: "/tosse-workflow:pickup",
      args: "",
    });
    expect(parseSlashCommand("  /done  ")).toEqual({ command: "/done", args: "" });
  });

  it("does not mistake a path or prose for a command", () => {
    // The name may not contain a slash — that is what keeps file paths out.
    expect(parseSlashCommand("/Users/alex/notes.md")).toBeNull();
    expect(parseSlashCommand("/usr/local/bin")).toBeNull();
    // A multi-line message is a prompt, even when it opens on a slash.
    expect(parseSlashCommand("/compact\n\nand then explain why")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/ hello")).toBeNull();
    expect(parseSlashCommand("what does /compact do?")).toBeNull();
  });

  it("collapses either shape to the same preview text", () => {
    expect(
      userMessagePreviewText(
        "<command-message>land</command-message>\n<command-name>/land</command-name>\n<command-args>now</command-args>",
      ),
    ).toBe("/land now");
    expect(userMessagePreviewText("/land now")).toBe("/land now");
    expect(userMessagePreviewText("fix the typo")).toBe("fix the typo");
  });
});

describe("parseSkillInvocation", () => {
  it("drops a plugin namespace to the short command", () => {
    expect(parseSkillInvocation({ skill: "tosse-workflow:done" })).toEqual({
      command: "/done",
      qualified: "tosse-workflow:done",
      args: "",
    });
  });

  it("keeps a bare project skill as-is and carries args", () => {
    expect(parseSkillInvocation({ skill: "code-review", args: "20" })).toEqual({
      command: "/code-review",
      qualified: "code-review",
      args: "20",
    });
    expect(parseSkillInvocation({ skill: "start" })).toEqual({
      command: "/start",
      qualified: "start",
      args: "",
    });
  });

  it("returns null when there is no skill field", () => {
    expect(parseSkillInvocation({})).toBeNull();
    expect(parseSkillInvocation({ skill: "  " })).toBeNull();
    expect(parseSkillInvocation("not an object" as never)).toBeNull();
  });
});
