import { beforeEach, describe, expect, it } from "vitest";
import {
  FACTORY_DEFAULTS,
  defaultEffortFor,
  defaultModelFor,
  normalize,
  useModelPrefs,
} from "./modelPrefs";
import { CLAUDE_MODELS, FACTORY_HIDDEN_MODELS, visibleModels } from "../features/conversation/models";

const factoryState = () => ({
  hidden: [...FACTORY_HIDDEN_MODELS],
  order: [],
  claudeModel: FACTORY_DEFAULTS.claudeModel,
  claudeEffort: FACTORY_DEFAULTS.claudeEffort,
  codexModel: FACTORY_DEFAULTS.codexModel,
  codexEffort: FACTORY_DEFAULTS.codexEffort,
});

beforeEach(() => {
  localStorage.clear();
  useModelPrefs.setState(factoryState());
});

describe("factory arrangement", () => {
  it("ships Opus 4.8 as the Claude default", () => {
    expect(defaultModelFor("claude")).toBe("claude-opus-4-8");
    expect(defaultEffortFor("claude")).toBe("xhigh");
  });

  it("hides Opus 5 out of the box, leaving one current model per family", () => {
    const shown = visibleModels(CLAUDE_MODELS, new Set(FACTORY_HIDDEN_MODELS)).map((m) => m.value);
    expect(shown).toEqual(["fable", "claude-opus-4-8", "sonnet", "haiku"]);
    expect(FACTORY_HIDDEN_MODELS).toContain("opus"); // Opus 5 — deliberate, not an oversight
  });

  it("the default model is one of the models actually shown", () => {
    const shown = visibleModels(CLAUDE_MODELS, new Set(FACTORY_HIDDEN_MODELS)).map((m) => m.value);
    expect(shown).toContain(FACTORY_DEFAULTS.claudeModel);
  });
});

describe("normalize (what a stored blob is allowed to say)", () => {
  it("seeds the factory hiding when nothing is stored", () => {
    expect(normalize(null).hidden).toEqual([...FACTORY_HIDDEN_MODELS]);
  });

  it("keeps an EMPTY hidden list — 'I want to see everything' must survive a restart", () => {
    // The bug this guards: treating [] as "unset" and re-seeding the factory hiding, so
    // the models the user un-hid quietly disappear again on the next launch.
    expect(normalize({ hidden: [] }).hidden).toEqual([]);
  });

  it("falls back to the factory default when the stored model is unknown to this version", () => {
    const p = normalize({ claudeModel: "claude-opus-9-9", codexModel: "gpt-nope" });
    expect(p.claudeModel).toBe(FACTORY_DEFAULTS.claudeModel);
    expect(p.codexModel).toBe(FACTORY_DEFAULTS.codexModel);
  });

  it("refuses a default from the WRONG backend (a Claude alias would be rejected by Codex)", () => {
    expect(normalize({ codexModel: "opus" }).codexModel).toBe(FACTORY_DEFAULTS.codexModel);
    expect(normalize({ claudeModel: "gpt-5.5" }).claudeModel).toBe(FACTORY_DEFAULTS.claudeModel);
  });

  it("clamps a stored effort to what the stored model actually accepts", () => {
    // Sonnet 4.6 takes `max` but NOT `xhigh` (from the CLI's own registry), so an xhigh
    // carried over from another model lands on `high` — never silently up on `max`.
    const p = normalize({ claudeModel: "claude-sonnet-4-6", claudeEffort: "xhigh" });
    expect(p.claudeEffort).toBe("high");
    // Opus 4.5 has no effort control at all → the request survives as-is (nothing to clamp to).
    expect(normalize({ claudeModel: "claude-opus-4-5", claudeEffort: "max" }).claudeEffort).toBe("max");
  });

  it("drops a garbage effort rather than passing it to the wire", () => {
    expect(normalize({ claudeEffort: "banana" }).claudeEffort).toBe(FACTORY_DEFAULTS.claudeEffort);
  });
});

describe("hiding and defaults stay consistent", () => {
  it("moves a default off a model the user just hid", () => {
    useModelPrefs.getState().setHidden("claude-opus-4-8", true);
    const s = useModelPrefs.getState();
    expect(s.hidden).toContain("claude-opus-4-8");
    // First still-shown Claude model — the picker's own top row, not a dead id.
    expect(s.claudeModel).toBe("fable");
  });

  it("keeps the default put when some OTHER model is hidden", () => {
    useModelPrefs.getState().setHidden("sonnet", true);
    expect(useModelPrefs.getState().claudeModel).toBe("claude-opus-4-8");
  });

  it("re-clamps the effort when the default model moves to a shallower ladder", () => {
    useModelPrefs.getState().setDefaultEffort("claude", "xhigh");
    useModelPrefs.getState().setDefaultModel("claude", "claude-sonnet-4-6"); // no xhigh
    expect(useModelPrefs.getState().claudeEffort).toBe("high");
  });

  it("persists across a reload", () => {
    useModelPrefs.getState().setHidden("opus", false); // show Opus 5
    useModelPrefs.getState().setDefaultModel("claude", "opus");
    const stored = normalize(JSON.parse(localStorage.getItem("tosse:models") || "null"));
    expect(stored.hidden).not.toContain("opus");
    expect(stored.claudeModel).toBe("opus");
  });
});

describe("visibleModels (the picker's own view of the catalogue)", () => {
  it("puts a model the user never dragged AFTER the ones they arranged", () => {
    const values = visibleModels(CLAUDE_MODELS, new Set(), ["haiku"]).map((m) => m.value);
    expect(values[0]).toBe("haiku");
    expect(values[1]).toBe("fable"); // catalogue order resumes
  });

  it("is stable for two unordered models (no reshuffle between renders)", () => {
    const once = visibleModels(CLAUDE_MODELS, new Set(), []).map((m) => m.value);
    const twice = visibleModels(CLAUDE_MODELS, new Set(), []).map((m) => m.value);
    expect(once).toEqual(twice);
    expect(once).toEqual(CLAUDE_MODELS.map((m) => m.value));
  });
});
