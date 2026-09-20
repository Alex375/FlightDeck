import { describe, expect, it } from "vitest";
import { artifactFace } from "./artifactIcon";

describe("artifactFace", () => {
  it("resolves the CURRENT wire: an `icon` WORD, with no favicon at all", () => {
    // Verbatim from a 2026-09-20 transcript: `{description, file_path, icon:"sparkle"}`.
    expect(artifactFace("sparkle", null)).toBe("✨");
    expect(artifactFace("report", null)).toBe("📑");
    expect(artifactFace("code", null)).toBe("💻");
    expect(artifactFace("chart", null)).toBe("📊");
    expect(artifactFace("calendar", null)).toBe("📅");
    expect(artifactFace("recipe", null)).toBe("🍳");
    expect(artifactFace("map", null)).toBe("🗺️");
  });

  it("keeps the LEGACY wire working: a `favicon` emoji, with no icon", () => {
    // Every transcript written before the change — they are never rewritten.
    expect(artifactFace(null, "📖")).toBe("📖");
    expect(artifactFace(null, "🛬")).toBe("🛬");
    expect(artifactFace(null, "✈️")).toBe("✈️");
  });

  it("prefers the emoji the CLI chose over one we derive, during the overlap", () => {
    // Both fields were sent for a couple of days (`icon:"plane"` + `favicon:"✈️"`).
    expect(artifactFace("logo", "🛬")).toBe("🛬");
    expect(artifactFace("report", "📑")).toBe("📑");
  });

  it("takes an emoji arriving on `icon` verbatim rather than looking it up", () => {
    expect(artifactFace("🎉", null)).toBe("🎉");
  });

  it("normalises spelling: case, spaces and separators", () => {
    expect(artifactFace("Bar Chart", null)).toBe("📊");
    expect(artifactFace("bar-chart", null)).toBe("📊");
    expect(artifactFace("BARCHART", null)).toBe("📊");
  });

  it("matches the LONGEST stem, so a short word never eats a specific one", () => {
    // "plane" must not be read as "plan".
    expect(artifactFace("plane", null)).toBe("✈️");
    expect(artifactFace("plan", null)).toBe("🗺️");
    expect(artifactFace("flightplan", null)).toBe("✈️");
    // "dashboard" is its own entry, not "board".
    expect(artifactFace("dashboard", null)).toBe("📊");
    expect(artifactFace("board", null)).toBe("📋");
  });

  it("falls back to the TYPE's name — a typed artifact names no icon at all", () => {
    // Verified over all 16 `Artifact` calls of a real Claude Design conversation: not one
    // carries `icon` or `favicon` (the tool ignores `icon` for an artifact made from a type).
    expect(artifactFace(null, null, "Design")).toBe("🎨");
    expect(artifactFace(null, null, "Slides")).toBe("📽️");
    expect(artifactFace(null, null, "Docs")).toBe("📄");
  });

  it("prefers the publish's OWN icon over its type", () => {
    expect(artifactFace("chart", null, "Design")).toBe("📊");
    expect(artifactFace(null, "🛬", "Design")).toBe("🛬");
  });

  it("says nothing rather than guessing when there is nothing to work with", () => {
    expect(artifactFace(null, null)).toBeNull();
    expect(artifactFace("", "  ")).toBeNull();
    // An unmapped word: the caller shows its own generic fallback.
    expect(artifactFace("zzqqx", null)).toBeNull();
  });
});
