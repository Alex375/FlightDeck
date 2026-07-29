import { describe, it, expect } from "vitest";
import { parseGoalCommand } from "./goalCommand";

describe("parseGoalCommand", () => {
  it("reads a SET in the CLI-wrapped shape (the reload path)", () => {
    // The real transcript shape: name, message, then args — possibly multi-line.
    expect(
      parseGoalCommand(
        "<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>ship the whole site</command-args>",
      ),
    ).toEqual({ action: "set", condition: "ship the whole site" });
    expect(
      parseGoalCommand("<command-name>/goal</command-name>\n<command-args>do X\nthen Y</command-args>"),
    ).toEqual({ action: "set", condition: "do X\nthen Y" });
  });

  it("reads a SET in the bare shape as typed (the live optimistic bubble)", () => {
    expect(parseGoalCommand("/goal ship the site")).toEqual({
      action: "set",
      condition: "ship the site",
    });
    // A condition may span multiple lines — unlike a generic slash-command.
    expect(parseGoalCommand("/goal do the whole thing\n- step 1\n- step 2")).toEqual({
      action: "set",
      condition: "do the whole thing\n- step 1\n- step 2",
    });
    // Newline right after /goal still opens the condition.
    expect(parseGoalCommand("/goal\nfinish everything")).toEqual({
      action: "set",
      condition: "finish everything",
    });
    expect(parseGoalCommand("  /goal trim me  ")).toEqual({ action: "set", condition: "trim me" });
  });

  it("tolerates an unterminated <command-args> like the Rust twin (command_args)", () => {
    // The CLI has shipped wrappers without a closing tag; Rust's `command_args` takes the
    // remainder so an unterminated SET stays a SET (kept in the thread as a card). The front
    // must agree, else Rust keeps the line but the front renders a bare chip instead of a card.
    expect(parseGoalCommand("<command-name>/goal</command-name>\n<command-args>ship the site")).toEqual(
      { action: "set", condition: "ship the site" },
    );
    // …and an unterminated EMPTY args is still a bare status query.
    expect(parseGoalCommand("<command-name>/goal</command-name>\n<command-args>")).toEqual({
      action: "status",
      condition: "",
    });
  });

  it("classifies clear and bare status (both shapes)", () => {
    expect(parseGoalCommand("/goal clear")).toEqual({ action: "clear", condition: "" });
    expect(parseGoalCommand("<command-name>/goal</command-name>\n<command-args>clear</command-args>")).toEqual(
      { action: "clear", condition: "" },
    );
    expect(parseGoalCommand("/goal")).toEqual({ action: "status", condition: "" });
    expect(parseGoalCommand("<command-name>/goal</command-name>\n<command-args></command-args>")).toEqual({
      action: "status",
      condition: "",
    });
    // No <command-args> tag at all is a bare status query too.
    expect(parseGoalCommand("<command-name>/goal</command-name>")).toEqual({
      action: "status",
      condition: "",
    });
  });

  it("returns null for anything that is not a /goal command", () => {
    expect(parseGoalCommand("/compact")).toBeNull();
    expect(parseGoalCommand("<command-name>/compact</command-name>")).toBeNull();
    // The word must END at /goal — "/goalpost" is not a goal command.
    expect(parseGoalCommand("/goalpost now")).toBeNull();
    expect(parseGoalCommand("please set a goal for me")).toBeNull();
    expect(parseGoalCommand("")).toBeNull();
  });
});
