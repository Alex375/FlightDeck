import { describe, expect, it } from "vitest";
import {
  ALL_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  backendOfModel,
  modelFamily,
  modelLabel,
  modelsForPicker,
} from "./models";

describe("backendOfModel", () => {
  it("classifies the Claude aliases + resolved ids as claude", () => {
    expect(backendOfModel("opus")).toBe("claude");
    expect(backendOfModel("sonnet")).toBe("claude");
    expect(backendOfModel("haiku")).toBe("claude");
    expect(backendOfModel("fable")).toBe("claude");
    expect(backendOfModel("claude-opus-4-8")).toBe("claude");
    expect(backendOfModel("claude-opus-5[1m]")).toBe("claude");
  });

  it("classifies the Codex model ids as codex (exact + resolved)", () => {
    expect(backendOfModel("gpt-5.5")).toBe("codex");
    expect(backendOfModel("gpt-5.4")).toBe("codex");
    expect(backendOfModel("gpt-5.4-mini")).toBe("codex");
    expect(backendOfModel("gpt-6-codex")).toBe("codex");
    expect(backendOfModel("o3")).toBe("codex");
  });

  it("defaults an unknown/empty id to claude (the app default backend)", () => {
    expect(backendOfModel(null)).toBe("claude");
    expect(backendOfModel(undefined)).toBe("claude");
    expect(backendOfModel("mystery-model")).toBe("claude");
  });

  it("the default Codex model classifies as codex", () => {
    expect(backendOfModel(DEFAULT_CODEX_MODEL)).toBe("codex");
  });
});

describe("modelLabel", () => {
  it("labels exact catalogue ids", () => {
    expect(modelLabel("opus")).toBe("Opus 5");
    expect(modelLabel("gpt-5.5")).toBe("GPT-5.5");
    expect(modelLabel("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
  });

  it("labels resolved Claude ids by family", () => {
    expect(modelLabel("claude-sonnet-5")).toBe("Sonnet 5");
  });

  it("labels Opus 4.8 by its full name, never as Opus 5", () => {
    expect(modelLabel("claude-opus-4-8")).toBe("Opus 4.8");
    // The resolved 1M-context id contains BOTH "claude-opus-4-8" and "opus" — the
    // longest catalogue value has to win.
    expect(modelLabel("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    // …and the generic Opus family still reads as Opus 5.
    expect(modelLabel("claude-opus-5[1m]")).toBe("Opus 5");
  });

  it("falls back to the raw id / placeholder", () => {
    expect(modelLabel(null)).toBe("Model");
    expect(modelLabel("weird-id")).toBe("weird-id");
  });
});

describe("modelFamily (menu highlight)", () => {
  it("maps a resolved Claude id back to its picker value", () => {
    expect(modelFamily("claude-opus-5[1m]")).toBe("opus");
  });
  it("highlights Opus 4.8 (full name) rather than the Opus family row", () => {
    expect(modelFamily("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(modelFamily("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
  });
  it("maps a Codex id (exact + longest-first) to its value", () => {
    expect(modelFamily("gpt-5.5")).toBe("gpt-5.5");
    expect(modelFamily("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });
  it("returns null for an unknown id", () => {
    expect(modelFamily("mystery")).toBeNull();
  });
});

describe("modelsForPicker (backend lock)", () => {
  it("fresh + Codex installed → both backends offered", () => {
    const g = modelsForPicker("claude", { locked: false, codexAvailable: true });
    expect(g.map((x) => x.backend)).toEqual(["claude", "codex"]);
  });

  it("fresh + no Codex → Claude only", () => {
    const g = modelsForPicker("claude", { locked: false, codexAvailable: false });
    expect(g.map((x) => x.backend)).toEqual(["claude"]);
  });

  it("locked Claude conv → only Claude models (backend frozen)", () => {
    const g = modelsForPicker("claude", { locked: true, codexAvailable: true });
    expect(g.map((x) => x.backend)).toEqual(["claude"]);
  });

  it("locked Codex conv → only Codex models (backend frozen)", () => {
    const g = modelsForPicker("codex", { locked: true, codexAvailable: true });
    expect(g.map((x) => x.backend)).toEqual(["codex"]);
    expect(g[0].models).toEqual(CODEX_MODELS);
  });

  it("offers our own catalogue, not the binary's own menu", () => {
    // Deliberate: `list_models` reports a CLI-shaped menu (a "Default (recommended)" row,
    // and the same model twice under its alias and its 1M variant). The picker shows our
    // catalogue rows instead — all of them when the user has hidden nothing.
    const g = modelsForPicker("claude", { locked: true, codexAvailable: false });
    expect(g[0].models).toEqual(CLAUDE_MODELS);
    expect(g[0].models.length).toBeGreaterThan(0);
  });

  it("offers only what the user kept, in the order they set", () => {
    const g = modelsForPicker("claude", {
      locked: true,
      codexAvailable: false,
      hidden: ["opus", "haiku"],
      order: ["sonnet", "claude-opus-4-8"],
    });
    const values = g[0].models.map((m) => m.value);
    expect(values).not.toContain("opus");
    expect(values).not.toContain("haiku");
    // Ordered ones first, in the user's order; everything else keeps its catalogue rank.
    expect(values.slice(0, 2)).toEqual(["sonnet", "claude-opus-4-8"]);
    expect(values[2]).toBe("fable");
  });

  it("still offers the model the conversation is RUNNING, even if it was hidden", () => {
    // Opus 5 ships hidden, so a conversation started on it before that must not end up
    // with a picker that can't show what it is on. Works from the resolved live id too.
    const g = modelsForPicker("claude", {
      locked: true,
      codexAvailable: false,
      hidden: ["opus", "haiku"],
      current: "claude-opus-5[1m]",
    });
    const values = g[0].models.map((m) => m.value);
    expect(values).toContain("opus");
    expect(values).not.toContain("haiku"); // the other hidden one stays hidden
  });

  it("drops a section the user emptied instead of rendering a bare heading", () => {
    const g = modelsForPicker("claude", {
      locked: true,
      codexAvailable: false,
      hidden: CLAUDE_MODELS.map((m) => m.value),
    });
    expect(g).toEqual([]);
  });

  it("locked Codex conv still shows its section even if Codex became unavailable (never empty)", () => {
    const g = modelsForPicker("codex", { locked: true, codexAvailable: false });
    expect(g.map((x) => x.backend)).toEqual(["codex"]);
  });
});

describe("catalogue integrity", () => {
  it("every model's value classifies to its own backend", () => {
    for (const m of ALL_MODELS) expect(backendOfModel(m.value)).toBe(m.backend);
  });
});
