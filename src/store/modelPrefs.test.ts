import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FACTORY_DEFAULTS,
  defaultEffortFor,
  defaultModelFor,
  normalize,
  reconcileSeen,
  useModelPrefs,
} from "./modelPrefs";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  FACTORY_HIDDEN_MODELS,
  codexFactoryHidden,
  latestClaudeModel,
  modelLabel,
  visibleModels,
} from "../features/conversation/models";

const factoryState = () => normalize(null);

beforeEach(() => {
  localStorage.clear();
  useModelPrefs.setState({ ...factoryState(), codexOffered: null });
});

/** What the picker shows for a set of prefs (Claude section, the user's order applied). */
const pickerOf = (p: { hidden: string[]; order: string[] }) =>
  visibleModels(CLAUDE_MODELS, new Set(p.hidden), p.order).map((m) => modelLabel(m.value));

describe("factory arrangement", () => {
  it("ships the newest Opus as the Claude default", () => {
    expect(defaultModelFor("claude")).toBe("opus");
    expect(modelLabel(defaultModelFor("claude"))).toBe("Opus 5.5");
    expect(defaultEffortFor("claude")).toBe("xhigh");
  });

  it("shows the newest model of each family out of the box — and never Mythos", () => {
    const shown = visibleModels(CLAUDE_MODELS, new Set(FACTORY_HIDDEN_MODELS)).map((m) => m.label);
    expect(shown).toEqual(["Fable 5.1", "Opus 5.5", "Sonnet 5", "Haiku 4.5"]);
    // Mythos 5.1 is the newest of ITS family, and still stays out.
    expect(FACTORY_HIDDEN_MODELS).toContain(latestClaudeModel("mythos")!.value);
  });

  it("derives the shown set from the catalogue: every family's first row, bar Mythos", () => {
    for (const m of CLAUDE_MODELS) {
      const newest = latestClaudeModel(m.family!) === m && m.family !== "mythos";
      expect(FACTORY_HIDDEN_MODELS.includes(m.value)).toBe(!newest);
    }
  });

  it("the default model is one of the models actually shown", () => {
    const shown = visibleModels(CLAUDE_MODELS, new Set(FACTORY_HIDDEN_MODELS)).map((m) => m.value);
    expect(shown).toContain(FACTORY_DEFAULTS.claudeModel);
  });

  it("shows the newest Codex model of each line out of the box", () => {
    const shown = visibleModels(CODEX_MODELS, new Set(FACTORY_HIDDEN_MODELS)).map((m) => m.value);
    // GPT-5.6 Terra has no GPT-6 successor yet, so it is still its line's newest.
    expect(shown).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"]);
  });
});

describe("codexFactoryHidden (the Codex half of 'newest by default')", () => {
  const ids = (...v: string[]) => v.map((value) => ({ value }));

  it("keeps each line's newest and retires a line-less model behind a newer generation", () => {
    // codex-cli 0.156.1, verbatim.
    const live = ids("gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5");
    expect(codexFactoryHidden(live).sort()).toEqual(["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol"]);
  });

  it("judges an older binary by what IT offers", () => {
    // codex-cli 0.144.4: no GPT-6 at all, so the 5.6 lineup is the newest there is.
    expect(codexFactoryHidden(ids("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"))).toEqual(["gpt-5.5"]);
  });

  it("keeps a line of its own (mini) and anything it cannot parse", () => {
    expect(codexFactoryHidden(ids("gpt-6-astra", "gpt-5.4-mini", "o3", "gpt-5.5"))).toEqual(["gpt-5.5"]);
  });
});

describe("the live Codex list", () => {
  const V156 = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
  const V144 = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
  const offer = (ids: string[], def: string) =>
    useModelPrefs.getState().noteCodexOffered(ids.map((value) => ({ value })), def);
  const codexShown = () =>
    visibleModels(
      useModelPrefs.getState().codexOffered!.ids.map((value) => ({ value, label: value, backend: "codex" as const })),
      new Set(useModelPrefs.getState().hidden),
    ).map((m) => m.value);

  it("gives a fresh install the newest of each line", () => {
    offer(V156, "gpt-6-astra");
    expect(codexShown()).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"]);
  });

  it("never overrules what the user did with a Codex model", () => {
    // Legacy blob: they had GPT-5.5 on show — they keep it, and the new GPT-6 Sol arrives.
    useModelPrefs.setState({ ...normalize({ hidden: [] }), codexOffered: null });
    offer(V156, "gpt-6-astra");
    expect(codexShown()).toContain("gpt-5.5");
    expect(codexShown()).toContain("gpt-6-sol");
    // A model they hid before the live list even loaded stays hidden.
    useModelPrefs.setState({ ...normalize(null), codexOffered: null });
    useModelPrefs.getState().setHidden("gpt-6-sol", true);
    offer(V156, "gpt-6-astra");
    expect(codexShown()).not.toContain("gpt-6-sol");
  });

  it("starts new Codex conversations on the binary's own default when it lacks the stored one", () => {
    expect(defaultModelFor("codex")).toBe("gpt-6-astra"); // list not loaded: the stored default
    offer(V144, "gpt-5.6-sol"); // an older binary with no GPT-6
    expect(defaultModelFor("codex")).toBe("gpt-5.6-sol");
    expect(useModelPrefs.getState().codexModel).toBe("gpt-6-astra"); // the choice is kept…
    offer(V156, "gpt-6-astra"); // …and wins again once the binary can run it
    expect(defaultModelFor("codex")).toBe("gpt-6-astra");
  });

  it("clamps the default effort to the model actually used", () => {
    useModelPrefs.getState().setDefaultEffort("codex", "ultra");
    offer(["gpt-5.5"], "gpt-5.5"); // tops out at xhigh
    expect(defaultEffortFor("codex")).toBe("xhigh");
  });
});

describe("models the user has never seen get the factory treatment", () => {
  // Real blobs written before `seen` existed (Opus 5 era: `opus` read "Opus 5").
  const LEGACY_FACTORY = {
    hidden: [
      "opus", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1",
      "claude-opus-4-0", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-0",
      "claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku", "claude-mythos-5",
    ],
    order: [],
    claudeModel: "claude-opus-4-8",
    claudeEffort: "xhigh",
  };
  const LEGACY_OPUS_USER = {
    hidden: [
      "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1",
      "claude-opus-4-0", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-0",
      "claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku", "claude-mythos-5",
      "claude-opus-4-8",
    ],
    order: ["fable", "claude-opus-4-8", "sonnet", "haiku", "gpt-5.6-sol", "opus"],
    claudeModel: "opus",
    claudeEffort: "xhigh",
  };

  it("a factory-era blob that hid Opus 5 now shows Opus 5.5 — and keeps Opus 5 hidden", () => {
    const p = normalize(LEGACY_FACTORY);
    expect(pickerOf(p)).toEqual(["Fable 5.1", "Opus 5.5", "Opus 4.8", "Sonnet 5", "Haiku 4.5"]);
    // The stored default is a choice on record: left alone.
    expect(p.claudeModel).toBe("claude-opus-4-8");
  });

  it("a blob that showed the Opus alias keeps it (now Opus 5.5) and is not handed Opus 5", () => {
    const p = normalize(LEGACY_OPUS_USER);
    expect(pickerOf(p)).toEqual(["Fable 5.1", "Sonnet 5", "Haiku 4.5", "Opus 5.5"]);
    expect(modelLabel(p.claudeModel)).toBe("Opus 5.5");
  });

  it("never surfaces Mythos 5.1 or the older Fable 5 to an existing user", () => {
    for (const blob of [LEGACY_FACTORY, LEGACY_OPUS_USER, { hidden: [] }]) {
      const p = normalize(blob);
      expect(p.hidden).toContain("claude-mythos-5-1");
      expect(p.hidden).toContain("claude-fable-5");
    }
  });

  it("keeps hidden what the user hid while it ran the same model", () => {
    // Hid Sonnet 5 in the legacy era: `sonnet` still runs Sonnet 5 → still hidden.
    expect(normalize({ hidden: ["sonnet"] }).hidden).toContain("sonnet");
    // Hid Opus 5.5 under the current catalogue: stays hidden on every later load.
    const now = normalize(null);
    const once = reconcileSeen([...now.hidden, "opus"], now.seen);
    expect(once.hidden).toContain("opus");
    expect(reconcileSeen(once.hidden, once.seen).hidden).toEqual(once.hidden);
  });

  it("does not un-hide a Codex model the user hid", () => {
    expect(normalize({ hidden: ["gpt-5.5"] }).hidden).toContain("gpt-5.5");
  });

  it("is idempotent — a reconciled blob reconciles to itself", () => {
    const p = normalize(LEGACY_FACTORY);
    const again = normalize(JSON.parse(JSON.stringify(p)));
    expect(again.hidden).toEqual(p.hidden);
    expect(again.seen).toEqual(p.seen);
  });

  it("writes the reconciliation back on load, once", async () => {
    localStorage.setItem("tosse:models", JSON.stringify(LEGACY_FACTORY));
    vi.resetModules();
    const fresh = await import("./modelPrefs");
    const stored = JSON.parse(localStorage.getItem("tosse:models")!);
    expect(stored.seen).toEqual(fresh.useModelPrefs.getState().seen);
    expect(stored.hidden).not.toContain("opus");
    expect(stored.hidden).toContain("claude-opus-5");
  });
});

describe("normalize (what a stored blob is allowed to say)", () => {
  it("seeds the factory hiding when nothing is stored", () => {
    expect(normalize(null).hidden).toEqual([...FACTORY_HIDDEN_MODELS]);
  });

  it("keeps an EMPTY hidden list — 'I want to see everything' must survive a restart", () => {
    // The bug this guards: treating [] as "unset" and re-seeding the factory hiding, so
    // the models the user un-hid quietly disappear again on the next launch.
    const everything = { hidden: [], seen: normalize(null).seen };
    expect(normalize(everything).hidden).toEqual([]);
    // A legacy blob (no `seen`) only has the models it never saw hidden — the ones it
    // un-hid stay shown.
    const legacy = normalize({ hidden: [] }).hidden;
    expect(legacy).not.toContain("claude-opus-4-7");
    expect([...legacy].sort()).toEqual(["claude-fable-5", "claude-mythos-5-1", "claude-opus-5"]);
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
    useModelPrefs.getState().setHidden("opus", true);
    const s = useModelPrefs.getState();
    expect(s.hidden).toContain("opus");
    // First still-shown Claude model — the picker's own top row, not a dead id.
    expect(s.claudeModel).toBe("fable");
  });

  it("keeps the default put when some OTHER model is hidden", () => {
    useModelPrefs.getState().setHidden("sonnet", true);
    expect(useModelPrefs.getState().claudeModel).toBe("opus");
  });

  it("re-clamps the effort when the default model moves to a shallower ladder", () => {
    useModelPrefs.getState().setDefaultEffort("claude", "xhigh");
    useModelPrefs.getState().setDefaultModel("claude", "claude-sonnet-4-6"); // no xhigh
    expect(useModelPrefs.getState().claudeEffort).toBe("high");
  });

  it("persists across a reload", () => {
    useModelPrefs.getState().setHidden("claude-opus-5", false); // show Opus 5
    useModelPrefs.getState().setDefaultModel("claude", "claude-opus-5");
    const stored = normalize(JSON.parse(localStorage.getItem("tosse:models") || "null"));
    expect(stored.hidden).not.toContain("claude-opus-5");
    expect(stored.claudeModel).toBe("claude-opus-5");
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
