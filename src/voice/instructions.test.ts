import { describe, it, expect } from "vitest";
import {
  DEFAULT_VOICE_INSTRUCTIONS,
  isCustomInstructions,
  resolveInstructions,
} from "./instructions";

describe("resolveInstructions", () => {
  it("falls back to the built-in brief for an empty override — clearing the box IS the reset", () => {
    expect(resolveInstructions("")).toBe(DEFAULT_VOICE_INSTRUCTIONS);
    expect(resolveInstructions("   \n  ")).toBe(DEFAULT_VOICE_INSTRUCTIONS);
    expect(resolveInstructions(null)).toBe(DEFAULT_VOICE_INSTRUCTIONS);
    expect(resolveInstructions(undefined)).toBe(DEFAULT_VOICE_INSTRUCTIONS);
  });

  it("uses the user's own brief verbatim, trimmed", () => {
    expect(resolveInstructions("  Be a pirate.  ")).toBe("Be a pirate.");
  });
});

describe("isCustomInstructions", () => {
  it("is false for empty and for the default pasted back in", () => {
    expect(isCustomInstructions("")).toBe(false);
    expect(isCustomInstructions(null)).toBe(false);
    expect(isCustomInstructions(`\n${DEFAULT_VOICE_INSTRUCTIONS}\n`)).toBe(false);
  });

  it("is true once the text really differs", () => {
    expect(isCustomInstructions("Be a pirate.")).toBe(true);
  });
});

describe("the default brief", () => {
  // The whole point of the rewrite: the agent kept padding its answers. These
  // assertions are the regression guard — a future edit that drops the ban is
  // how the padding comes back.
  it("bans the filler openers and the « je reviens vers toi » sign-off", () => {
    expect(DEFAULT_VOICE_INSTRUCTIONS).toContain("je reviens vers toi");
    expect(DEFAULT_VOICE_INSTRUCTIONS).toContain("c'est bon");
    expect(DEFAULT_VOICE_INSTRUCTIONS.toLowerCase()).toContain("no preamble");
  });

  // Radio discipline: a SHORT pleasantry is still a pleasantry, and spoken, it is
  // time the user has to sit through. Greetings and sign-offs must get silence.
  it("forbids greetings and spoken sign-offs outright", () => {
    const brief = DEFAULT_VOICE_INSTRUCTIONS;
    expect(brief).toContain("Never greet and never sign off");
    expect(brief).toContain("au revoir");
    expect(brief).toContain("à la prochaine");
    expect(brief).toContain("end_call and stay silent");
    // …and it must not ask for the goodbye it just banned.
    expect(brief).not.toMatch(/say goodbye/i);
  });

  // The one sanctioned pleasantry, because pure silence can't be told apart from
  // "didn't hear you". A fixed call sign, never a prefix to a real report.
  it("allows exactly one acknowledgement, as a fixed verbatim", () => {
    const brief = DEFAULT_VOICE_INSTRUCTIONS;
    expect(brief).toContain("« Bien reçu. »");
    expect(brief).toContain('"Roger."');
    expect(brief).toContain("Never pair it with a report");
    expect(brief).toContain("five reasons");
  });

  it("still names the tools the agent must ground itself in", () => {
    for (const tool of [
      "list_conversations",
      "read_conversation",
      "send_message",
      "search_past_conversations",
      "reopen_conversation",
      "acknowledge_conversation",
      "remove_conversation",
      "browse_folders",
      "end_call",
    ]) {
      expect(DEFAULT_VOICE_INSTRUCTIONS).toContain(tool);
    }
  });
});
