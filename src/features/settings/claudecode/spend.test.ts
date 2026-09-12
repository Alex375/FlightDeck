import { describe, expect, it } from "vitest";

import type { SpendBucket } from "../../../ipc/bindings";
import {
  applyFilter,
  catalogueIdForTranscriptModel,
  continuousDays,
  costAtModel,
  costOfBucket,
  dailyByModel,
  DEFAULT_CACHE_RATIOS,
  DEFAULT_RATES,
  findDrift,
  formatCost,
  groupSpend,
  labelForTranscriptModel,
  modelsByRepo,
  prettifyModelId,
  pricingKeyForTranscriptModel,
  stripDateSuffix,
  transcriptIdForLabel,
  type RateCard,
} from "./spend";

const CARD: RateCard = { rates: DEFAULT_RATES, cache: DEFAULT_CACHE_RATIOS };

function bucket(over: Partial<SpendBucket> = {}): SpendBucket {
  return {
    day: "2026-09-01",
    repo: "/r/app",
    repo_label: "app",
    agent: "Explore",
    model: "claude-opus-4-8",
    workflow: false,
    turns: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    ...over,
  };
}

describe("matching a transcript model id to the catalogue", () => {
  // The six model ids that actually appear in the real corpus on this machine.
  it("resolves every model id observed in real transcripts", () => {
    expect(catalogueIdForTranscriptModel("claude-fable-5-1")).toBe("fable");
    expect(catalogueIdForTranscriptModel("claude-opus-5")).toBe("opus");
    expect(catalogueIdForTranscriptModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(catalogueIdForTranscriptModel("claude-sonnet-5")).toBe("sonnet");
    expect(catalogueIdForTranscriptModel("claude-haiku-4-5-20251001")).toBe("haiku");
    // Fable 5 is NOT in the picker catalogue, yet it is ~30% of the real corpus. It has to
    // survive as its own priced, labelled row anyway — see pricingKeyForTranscriptModel.
    expect(catalogueIdForTranscriptModel("claude-fable-5")).toBeNull();
    expect(pricingKeyForTranscriptModel("claude-fable-5")).toBe("claude-fable-5");
  });

  it("keeps Fable 5 and Fable 5.1 apart", () => {
    // The trap: `claude-fable-5` is a PREFIX of `claude-fable-5-1`. Matching loosely folds
    // thousands of Fable 5.1 turns into Fable 5 — both are large, real rows.
    expect(labelForTranscriptModel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(labelForTranscriptModel("claude-fable-5")).toBe("Fable 5");
    expect(pricingKeyForTranscriptModel("claude-fable-5-1")).not.toBe(
      pricingKeyForTranscriptModel("claude-fable-5"),
    );
  });

  it("prices and names a model the picker does not offer", () => {
    // The failure this prevents: a dash and a blank next to a third of the spend.
    const cost = costOfBucket(bucket({ model: "claude-fable-5", output_tokens: 1_000_000 }), CARD);
    expect(cost).toBeCloseTo(50, 6);
    expect(prettifyModelId("claude-fable-5")).toBe("Fable 5");
    expect(prettifyModelId("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(prettifyModelId("claude-3-7-sonnet")).toBe("claude-3-7-sonnet");
  });

  it("strips a date suffix", () => {
    expect(stripDateSuffix("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(stripDateSuffix("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("derives the transcript id a label would have", () => {
    expect(transcriptIdForLabel("Fable 5.1")).toBe("claude-fable-5-1");
    expect(transcriptIdForLabel("Opus 4.8")).toBe("claude-opus-4-8");
    expect(transcriptIdForLabel("Haiku 4.5")).toBe("claude-haiku-4-5");
  });

  it("still names and counts a model the catalogue has never heard of", () => {
    // A model released after this build must never vanish from the dashboard — it gets a
    // derived name and its own pricing key, so its turns stay visible and countable.
    expect(catalogueIdForTranscriptModel("claude-unreleased-9")).toBeNull();
    expect(labelForTranscriptModel("claude-unreleased-9")).toBe("Unreleased 9");
    expect(pricingKeyForTranscriptModel("claude-unreleased-9")).toBe("claude-unreleased-9");
    // …but with no rate on the card, its cost is unknown rather than zero.
    expect(costOfBucket(bucket({ model: "claude-unreleased-9", output_tokens: 9 }), CARD)).toBeNull();
  });
});

describe("costing", () => {
  it("prices input, output and both kinds of cache token", () => {
    const cost = costOfBucket(
      bucket({
        model: "claude-opus-4-8", // $5 in / $25 out
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 1_000_000, // 0.1 × 5 = $0.50
        cache_creation_tokens: 1_000_000, // 1.25 × 5 = $6.25
      }),
      CARD,
    );
    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
  });

  it("reports an unpriced model as unknown, never as free", () => {
    // A zero here would quietly shrink the total and make an expensive unknown model
    // look like it cost nothing.
    const cost = costOfBucket(bucket({ model: "claude-unreleased-9", output_tokens: 5_000_000 }), CARD);
    expect(cost).toBeNull();
  });

  it("propagates an unpriced model to the row it lands in", () => {
    const rows = groupSpend(
      [bucket({ model: "claude-unreleased-9", output_tokens: 10 })],
      "model",
      CARD,
    );
    expect(rows[0]!.cost).toBeNull();
  });

  it("costs the same volume at another model's rates", () => {
    const buckets = [bucket({ output_tokens: 1_000_000 })];
    // Fable 5.1 output is $50/M; Sonnet 5 is $10/M.
    expect(costAtModel(buckets, "fable", CARD)).toBeCloseTo(50, 6);
    expect(costAtModel(buckets, "sonnet", CARD)).toBeCloseTo(10, 6);
    expect(costAtModel(buckets, "nope", CARD)).toBeNull();
  });

  it("matches the published rate card for every priced model", () => {
    expect(DEFAULT_RATES["fable"]).toEqual({ input: 10, output: 50 });
    expect(DEFAULT_RATES["claude-fable-5"]).toEqual({ input: 10, output: 50 });
    expect(DEFAULT_RATES["opus"]).toEqual({ input: 5, output: 25 });
    expect(DEFAULT_RATES["claude-opus-4-8"]).toEqual({ input: 5, output: 25 });
    expect(DEFAULT_RATES["claude-opus-4-7"]).toEqual({ input: 5, output: 25 });
    expect(DEFAULT_RATES["sonnet"]).toEqual({ input: 2, output: 10 });
    expect(DEFAULT_RATES["claude-sonnet-4-6"]).toEqual({ input: 3, output: 15 });
    expect(DEFAULT_RATES["haiku"]).toEqual({ input: 1, output: 5 });
  });
});

describe("grouping and filtering", () => {
  const corpus = [
    bucket({ day: "2026-09-01", repo: "/r/a", repo_label: "a", agent: "Explore", model: "claude-opus-4-8", output_tokens: 100, turns: 3 }),
    bucket({ day: "2026-09-02", repo: "/r/a", repo_label: "a", agent: "Explore", model: "claude-opus-4-8", output_tokens: 50, turns: 2 }),
    bucket({ day: "2026-09-02", repo: "/r/b", repo_label: "b", agent: "workflow-subagent", model: "claude-fable-5-1", output_tokens: 900, turns: 9, workflow: true }),
  ];

  it("folds by model, biggest first", () => {
    const rows = groupSpend(corpus, "model", CARD);
    expect(rows.map((r) => r.label)).toEqual(["Fable 5.1", "Opus 4.8"]);
    expect(rows[1]!.turns).toBe(5);
    expect(rows[1]!.outputTokens).toBe(150);
  });

  it("folds by agent and by repo", () => {
    expect(groupSpend(corpus, "agent", CARD).map((r) => r.label)).toEqual([
      "workflow-subagent",
      "Explore",
    ]);
    expect(groupSpend(corpus, "repo", CARD).map((r) => r.label)).toEqual(["b", "a"]);
  });

  it("filters by date, repo and workflow", () => {
    expect(applyFilter(corpus, { since: "2026-09-02", repo: null, includeWorkflow: true })).toHaveLength(2);
    expect(applyFilter(corpus, { since: null, repo: "/r/a", includeWorkflow: true })).toHaveLength(2);
    // Excluding workflow runs must remove the bulk — that is the whole point of the toggle.
    const noWf = applyFilter(corpus, { since: null, repo: null, includeWorkflow: false });
    expect(noWf).toHaveLength(2);
    expect(noWf.every((b) => !b.workflow)).toBe(true);
  });
});

describe("chart shaping", () => {
  it("fills gaps between days instead of compressing them", () => {
    // A quiet stretch must read as quiet, not vanish.
    expect(continuousDays("2026-09-01", "2026-09-04")).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    expect(continuousDays("2026-09-01", "2026-09-01")).toEqual(["2026-09-01"]);
  });

  it("builds one index-aligned series per model", () => {
    const series = dailyByModel(
      [
        bucket({ day: "2026-09-01", model: "claude-opus-4-8", output_tokens: 10 }),
        bucket({ day: "2026-09-03", model: "claude-opus-4-8", output_tokens: 30 }),
        bucket({ day: "2026-09-03", model: "claude-sonnet-5", output_tokens: 5 }),
      ],
      CARD,
      "output",
    );
    expect(series.days).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    const opus = series.series.find((s) => s.label === "Opus 4.8")!;
    expect(opus.values).toEqual([10, 0, 30]);
    const sonnet = series.series.find((s) => s.label === "Sonnet 5")!;
    expect(sonnet.values).toEqual([0, 0, 5]);
  });

  it("returns nothing for an empty corpus rather than throwing", () => {
    expect(dailyByModel([], CARD)).toEqual({ days: [], series: [] });
    expect(modelsByRepo([], CARD)).toEqual([]);
    expect(groupSpend([], "model", CARD)).toEqual([]);
  });

  it("breaks each repo down by model, biggest repo first", () => {
    const rows = modelsByRepo(
      [
        bucket({ repo: "/r/a", repo_label: "a", model: "claude-opus-4-8", output_tokens: 1_000_000 }),
        bucket({ repo: "/r/a", repo_label: "a", model: "haiku", output_tokens: 1_000 }),
        bucket({ repo: "/r/b", repo_label: "b", model: "claude-opus-4-8", output_tokens: 10 }),
      ],
      CARD,
    );
    expect(rows.map((r) => r.label)).toEqual(["a", "b"]);
    expect(rows[0]!.parts[0]!.label).toBe("Opus 4.8");
    expect(rows[0]!.total).toBeGreaterThan(rows[1]!.total);
  });
});

describe("the drift canary", () => {
  it("stays silent when the alias and the resolved id are the same model", () => {
    // Configured `haiku`, transcripts say `claude-haiku-4-5-20251001`. Same model, two
    // spellings — flagging this would cry wolf on every correctly configured agent.
    const findings = findDrift(
      [bucket({ agent: "Explore", model: "claude-haiku-4-5-20251001", turns: 40 })],
      [{ name: "Explore", model: "haiku" }],
    );
    expect(findings).toEqual([]);
  });

  it("fires when an agent runs on something other than what it is set to", () => {
    const findings = findDrift(
      [
        bucket({ agent: "Explore", model: "claude-opus-4-8", turns: 12 }),
        bucket({ agent: "Explore", model: "claude-haiku-4-5-20251001", turns: 3 }),
      ],
      [{ name: "Explore", model: "haiku" }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      agent: "Explore",
      configuredLabel: "Haiku 4.5",
      observedLabel: "Opus 4.8",
      turns: 12,
    });
  });

  it("ignores agents that have no configured model", () => {
    // "Inherit the conversation" cannot disagree with anything.
    expect(
      findDrift([bucket({ agent: "Plan", model: "claude-opus-4-8" })], [{ name: "Plan", model: null }]),
    ).toEqual([]);
  });

  it("ignores agents the dashboard has no setting for", () => {
    expect(
      findDrift([bucket({ agent: "workflow-subagent", model: "claude-fable-5-1" })], [
        { name: "Explore", model: "haiku" },
      ]),
    ).toEqual([]);
  });

  it("ignores turns that ran BEFORE the setting was changed", () => {
    // The bug this fixes: setting Code search to Haiku today made the banner fire
    // immediately, because the whole week behind it ran on Opus — under the old setting.
    // A warning at the exact moment you change something is how a canary loses its
    // credibility.
    const changedAt = Date.parse("2026-09-05T10:00:00Z");
    const findings = findDrift(
      [
        bucket({ day: "2026-09-03", agent: "Explore", model: "claude-opus-4-8", turns: 500 }),
        bucket({ day: "2026-09-05", agent: "Explore", model: "claude-opus-4-8", turns: 40 }),
      ],
      [{ name: "Explore", model: "haiku", configuredAtMs: changedAt }],
    );
    expect(findings).toEqual([]);
  });

  it("still fires for turns that ran after the change, and says since when", () => {
    const changedAt = Date.parse("2026-09-05T10:00:00Z");
    const findings = findDrift(
      [
        bucket({ day: "2026-09-04", agent: "Explore", model: "claude-opus-4-8", turns: 500 }),
        bucket({ day: "2026-09-07", agent: "Explore", model: "claude-opus-4-8", turns: 6 }),
      ],
      [{ name: "Explore", model: "haiku", configuredAtMs: changedAt }],
    );
    expect(findings).toHaveLength(1);
    // Only the turns after the change are counted — the 500 before it are not evidence.
    expect(findings[0]!.turns).toBe(6);
    expect(findings[0]!.since).toBe("2026-09-05");
  });

  it("falls back to the whole window when the change date is unknown", () => {
    const findings = findDrift(
      [bucket({ agent: "Explore", model: "claude-opus-4-8", turns: 3 })],
      [{ name: "Explore", model: "haiku", configuredAtMs: null }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.since).toBeNull();
  });

  it("ranks the worst offender first", () => {
    const findings = findDrift(
      [
        bucket({ agent: "Explore", model: "claude-opus-4-8", turns: 2 }),
        bucket({ agent: "Explore", model: "claude-fable-5-1", turns: 90 }),
      ],
      [{ name: "Explore", model: "haiku" }],
    );
    expect(findings.map((f) => f.observedLabel)).toEqual(["Fable 5.1", "Opus 4.8"]);
  });
});

describe("formatting", () => {
  it("never rounds a real cost down to nothing", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatCost(1234.5)).toBe("$1,235");
  });
});
