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

  it("falls back to the raw id / placeholder", () => {
    expect(modelLabel(null)).toBe("Model");
    expect(modelLabel("weird-id")).toBe("weird-id");
  });
});

describe("modelFamily (menu highlight)", () => {
  it("maps a resolved Claude id back to its picker value", () => {
    expect(modelFamily("claude-opus-5[1m]")).toBe("opus");
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
    expect(g[0].models).toBe(CODEX_MODELS);
  });

  it("offers the curated Claude catalogue, not the binary's own menu", () => {
    // Deliberate: `list_models` reports a CLI-shaped menu (a "Default (recommended)" row,
    // and the same model twice under its alias and its 1M variant). The picker shows our
    // four curated rows instead.
    const g = modelsForPicker("claude", { locked: true, codexAvailable: false });
    expect(g[0].models).toBe(CLAUDE_MODELS);
    expect(g[0].models.length).toBeGreaterThan(0);
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
