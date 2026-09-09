// Turning raw sub-agent turns into money and shapes — all of it pure, so the numbers on
// the dashboard are testable without a filesystem, a chart, or a render.
//
// Three jobs live here:
//   1. matching a transcript's model id to the app's model catalogue (harder than it
//      looks — see `catalogueIdForTranscriptModel`),
//   2. costing a bucket against an EDITABLE rate card,
//   3. pivoting the flat bucket list into the rows and series the tables and charts want.
//
// ⚠️ Every figure this file produces is an Anthropic API-rate-card estimate. On a Claude
// subscription none of it is billed. The UI says so out loud; the maths here is only ever
// a way to compare models against each other on one scale.
import type { SpendBucket } from "../../../ipc/bindings";
import { CLAUDE_MODELS, type ModelOption } from "../../conversation/models";

// ---- Rate card -------------------------------------------------------------

/** What one model costs, in US dollars per million tokens. */
export interface ModelRate {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens. */
  output: number;
}

/**
 * Cache tokens are priced as multiples of the input rate rather than as their own column:
 * that is how Anthropic's rate card expresses them, and it keeps the editable table down
 * to the two numbers a person can actually look up.
 *
 * These are the published ratios (cache reads ~0.1x input, cache writes ~1.25x). They are
 * data, not constants buried in a formula, so a change in the rate card is an edit rather
 * than a release.
 */
export interface CacheRatios {
  read: number;
  write: number;
}

export const DEFAULT_CACHE_RATIOS: CacheRatios = { read: 0.1, write: 1.25 };

/**
 * The factory rate card, keyed by the app catalogue's model VALUE. Anthropic's published
 * per-million-token prices at the time of writing; every one of them is editable in
 * Settings, and a model absent from this table simply has no price until someone gives it
 * one (it still shows its token counts — an unpriced model must not silently read as free).
 */
export const DEFAULT_RATES: Record<string, ModelRate> = {
  fable: { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  sonnet: { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

export interface RateCard {
  rates: Record<string, ModelRate>;
  cache: CacheRatios;
}

// ---- Matching a transcript model id to the catalogue -----------------------

/**
 * The id a transcript would use for a catalogue entry, derived from its display label:
 * `Fable 5.1` → `claude-fable-5-1`, `Opus 4.8` → `claude-opus-4-8`.
 *
 * Needed because the catalogue stores ALIASES for the newest of each family (`fable`,
 * `opus`, `haiku`) while transcripts always record the fully resolved id. Matching on the
 * alias alone would fold Fable 5 and Fable 5.1 — two separate rows in the real data, with
 * thousands of turns each — into one line.
 */
export function transcriptIdForLabel(label: string): string {
  return `claude-${label.toLowerCase().replace(/[\s.]+/g, "-")}`;
}

/** Strip a trailing date stamp: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
export function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

/**
 * Match a model id as written in a transcript to its catalogue entry.
 *
 * Exact match first, then the longest prefix — order matters: `claude-fable-5` is a prefix
 * of `claude-fable-5-1`, so a first-prefix-wins search would report every Fable 5.1 turn
 * as Fable 5. Returns `null` for a model the catalogue has never heard of, which the UI
 * shows under its raw id rather than hiding.
 */
export function catalogueIdForTranscriptModel(modelId: string): string | null {
  const id = stripDateSuffix(modelId.toLowerCase());
  const candidates: Array<{ candidate: string; value: string }> = [];
  for (const m of CLAUDE_MODELS) {
    candidates.push({ candidate: transcriptIdForLabel(m.label), value: m.value });
    candidates.push({ candidate: m.value, value: m.value });
  }
  for (const { candidate, value } of candidates) {
    if (candidate === id) return value;
  }
  const prefixed = candidates
    .filter(({ candidate }) => id.startsWith(`${candidate}-`))
    .sort((a, b) => b.candidate.length - a.candidate.length);
  return prefixed[0]?.value ?? null;
}

/** The catalogue entry for a transcript model id, when there is one. */
export function optionForTranscriptModel(modelId: string): ModelOption | undefined {
  const value = catalogueIdForTranscriptModel(modelId);
  return value ? CLAUDE_MODELS.find((m) => m.value === value) : undefined;
}

/**
 * The key a model is priced under.
 *
 * ⚠️ Not the same thing as its catalogue id, and the difference is load-bearing: the
 * catalogue lists what the picker OFFERS, while this dashboard reports what actually RAN.
 * Those sets differ — `claude-fable-5` is absent from the catalogue yet accounts for
 * thousands of real sub-agent turns on this machine. Falling back to the date-stripped
 * transcript id means such a model is still priced and still counted, instead of showing
 * a dash next to a third of the spend.
 */
export function pricingKeyForTranscriptModel(modelId: string): string {
  return catalogueIdForTranscriptModel(modelId) ?? stripDateSuffix(modelId.toLowerCase());
}

/**
 * Display name for a transcript model id. The catalogue's label when it has one, otherwise
 * a name derived from the id (`claude-fable-5` → `Fable 5`) so a model the picker does not
 * offer still reads like a model rather than like a wire string.
 */
export function labelForTranscriptModel(modelId: string): string {
  const known = optionForTranscriptModel(modelId);
  if (known) return known.label;
  return prettifyModelId(modelId);
}

/**
 * `claude-fable-5` → `Fable 5`; `claude-sonnet-4-6` → `Sonnet 4.6`. Words become the name,
 * trailing numbers become a dotted version. Anything that does not fit that shape is
 * returned untouched — a guess that reads worse than the raw id is not worth making.
 */
export function prettifyModelId(modelId: string): string {
  const parts = stripDateSuffix(modelId.toLowerCase()).replace(/^claude-/, "").split("-");
  const words: string[] = [];
  const numbers: string[] = [];
  for (const part of parts) {
    if (numbers.length === 0 && !/^\d+$/.test(part)) words.push(part);
    else if (/^\d+$/.test(part)) numbers.push(part);
    else return modelId; // a word after the version — not a shape we understand
  }
  if (words.length === 0) return modelId;
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return numbers.length ? `${name} ${numbers.join(".")}` : name;
}

// ---- Costing ---------------------------------------------------------------

/** The rate for a transcript model id, or `null` when the card does not price it. */
export function rateForTranscriptModel(modelId: string, card: RateCard): ModelRate | null {
  return card.rates[pricingKeyForTranscriptModel(modelId)] ?? null;
}

/**
 * What one bucket would have cost at API rates. `null` — not `0` — when the model has no
 * price: a zero would quietly fold an unpriced model into the total and make the bill look
 * smaller than it is.
 */
export function costOfBucket(bucket: SpendBucket, card: RateCard): number | null {
  const rate = rateForTranscriptModel(bucket.model, card);
  if (!rate) return null;
  const perToken = (n: number, dollarsPerMillion: number) => (n / 1_000_000) * dollarsPerMillion;
  return (
    perToken(bucket.input_tokens, rate.input) +
    perToken(bucket.output_tokens, rate.output) +
    perToken(bucket.cache_read_tokens, rate.input * card.cache.read) +
    perToken(bucket.cache_creation_tokens, rate.input * card.cache.write)
  );
}

/**
 * The counterfactual: the same token counts, billed at another model's rates.
 *
 * ⚠️ Deliberately NOT presented as a prediction. A cheaper model would not emit the same
 * tokens for the same work — it might need more turns, or fewer. This is "what this volume
 * costs on each price tier", which is a fair way to compare tiers and an unfair way to
 * forecast a bill. The UI carries that caveat next to the number.
 */
export function costAtModel(
  buckets: SpendBucket[],
  targetCatalogueId: string,
  card: RateCard,
): number | null {
  const rate = card.rates[targetCatalogueId];
  if (!rate) return null;
  let total = 0;
  for (const b of buckets) {
    total +=
      (b.input_tokens / 1_000_000) * rate.input +
      (b.output_tokens / 1_000_000) * rate.output +
      (b.cache_read_tokens / 1_000_000) * rate.input * card.cache.read +
      (b.cache_creation_tokens / 1_000_000) * rate.input * card.cache.write;
  }
  return total;
}

// ---- Filtering and pivoting ------------------------------------------------

export interface SpendFilter {
  /** Inclusive lower bound as `YYYY-MM-DD`; `null` for "everything". */
  since: string | null;
  /** Absolute repo path, or `null` for every repo. */
  repo: string | null;
  /** Whether workflow-run turns are included. */
  includeWorkflow: boolean;
}

export const ALL_TIME: SpendFilter = { since: null, repo: null, includeWorkflow: true };

/** `YYYY-MM-DD` for `days` ago, in UTC — the same clock the transcripts stamp with. */
export function dayCutoff(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function applyFilter(buckets: SpendBucket[], filter: SpendFilter): SpendBucket[] {
  return buckets.filter(
    (b) =>
      (filter.since === null || b.day >= filter.since) &&
      (filter.repo === null || b.repo === filter.repo) &&
      (filter.includeWorkflow || !b.workflow),
  );
}

/** One aggregated line of a table, whatever it is grouped by. */
export interface SpendRow {
  key: string;
  label: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** `null` when at least one contributing model has no price on the card. */
  cost: number | null;
}

type GroupBy = "model" | "agent" | "repo";

/**
 * Fold buckets into rows, biggest first. Sorted by output tokens rather than cost so the
 * order still means something when part of the corpus is unpriced.
 */
export function groupSpend(
  buckets: SpendBucket[],
  by: GroupBy,
  card: RateCard,
): SpendRow[] {
  const rows = new Map<string, SpendRow & { unpriced: boolean }>();
  for (const b of buckets) {
    const key = by === "model" ? b.model : by === "agent" ? b.agent : b.repo;
    const label =
      by === "model" ? labelForTranscriptModel(b.model) : by === "agent" ? b.agent : b.repo_label;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        label,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cost: 0,
        unpriced: false,
      };
      rows.set(key, row);
    }
    row.turns += b.turns;
    row.inputTokens += b.input_tokens;
    row.outputTokens += b.output_tokens;
    row.cacheReadTokens += b.cache_read_tokens;
    row.cacheCreationTokens += b.cache_creation_tokens;
    const cost = costOfBucket(b, card);
    if (cost === null) row.unpriced = true;
    else if (row.cost !== null) row.cost += cost;
  }
  return [...rows.values()]
    .map(({ unpriced, ...row }) => ({ ...row, cost: unpriced ? null : row.cost }))
    .sort((a, b) => b.outputTokens - a.outputTokens);
}

/** A stacked time series: one entry per day, one number per series key. */
export interface DaySeries {
  days: string[];
  /** Series key (a model id) → its value on each day, index-aligned with `days`. */
  series: Array<{ key: string; label: string; values: number[] }>;
}

/**
 * Daily totals per model, over a CONTINUOUS run of days — gaps included as zeroes rather
 * than skipped, so a quiet week reads as a quiet week instead of being compressed away.
 */
export function dailyByModel(
  buckets: SpendBucket[],
  card: RateCard,
  metric: "cost" | "output" = "cost",
): DaySeries {
  if (buckets.length === 0) return { days: [], series: [] };
  const sorted = [...buckets].sort((a, b) => a.day.localeCompare(b.day));
  const days = continuousDays(sorted[0]!.day, sorted[sorted.length - 1]!.day);
  const index = new Map(days.map((d, i) => [d, i]));
  const byModel = new Map<string, number[]>();
  for (const b of buckets) {
    const i = index.get(b.day);
    if (i === undefined) continue;
    let values = byModel.get(b.model);
    if (!values) {
      values = new Array(days.length).fill(0);
      byModel.set(b.model, values);
    }
    values[i] += metric === "cost" ? (costOfBucket(b, card) ?? 0) : b.output_tokens;
  }
  const series = [...byModel.entries()]
    .map(([key, values]) => ({ key, label: labelForTranscriptModel(key), values }))
    .sort((a, b) => sum(b.values) - sum(a.values));
  return { days, series };
}

/** Every date from `first` to `last` inclusive. */
export function continuousDays(first: string, last: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${last}T00:00:00Z`);
  let t = Date.parse(`${first}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(end) || end < t) return first === last ? [first] : out;
  // A guard rather than a `while (true)`: a corrupt pair of dates must not spin forever.
  for (let i = 0; t <= end && i < 3650; i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** Model mix per repo, as absolute values — the caller decides whether to normalise. */
export function modelsByRepo(
  buckets: SpendBucket[],
  card: RateCard,
): Array<{ repo: string; label: string; total: number; parts: Array<{ key: string; label: string; value: number }> }> {
  const repos = new Map<string, { label: string; parts: Map<string, number> }>();
  for (const b of buckets) {
    let entry = repos.get(b.repo);
    if (!entry) {
      entry = { label: b.repo_label, parts: new Map() };
      repos.set(b.repo, entry);
    }
    const cost = costOfBucket(b, card) ?? 0;
    entry.parts.set(b.model, (entry.parts.get(b.model) ?? 0) + cost);
  }
  return [...repos.entries()]
    .map(([repo, { label, parts }]) => {
      const list = [...parts.entries()]
        .map(([key, value]) => ({ key, label: labelForTranscriptModel(key), value }))
        .sort((a, b) => b.value - a.value);
      return { repo, label, total: sum(list.map((p) => p.value)), parts: list };
    })
    .sort((a, b) => b.total - a.total);
}

// ---- The drift canary ------------------------------------------------------

/**
 * A configured routing that the transcripts contradict.
 *
 * This is the check that makes the whole feature trustworthy over time. The resolution
 * order changed once already (2.1.251), and a built-in's NAME is an undocumented contract:
 * either can break an override with no error anywhere. Comparing intent against what
 * actually ran is the only signal that survives both.
 */
export interface DriftFinding {
  agent: string;
  configuredModel: string;
  configuredLabel: string;
  observedModel: string;
  observedLabel: string;
  turns: number;
}

/**
 * Find agents whose recent turns ran on a model other than the one they are configured for.
 *
 * Compares CATALOGUE ids, not raw strings — `haiku` and `claude-haiku-4-5-20251001` are the
 * same model written two ways, and reporting that as drift would cry wolf on every correctly
 * configured agent.
 */
export function findDrift(
  buckets: SpendBucket[],
  configured: Array<{ name: string; model: string | null }>,
): DriftFinding[] {
  const wanted = new Map(
    configured
      .filter((c): c is { name: string; model: string } => !!c.model)
      .map((c) => [c.name, c.model]),
  );
  const seen = new Map<string, Map<string, number>>();
  for (const b of buckets) {
    if (!wanted.has(b.agent)) continue;
    let models = seen.get(b.agent);
    if (!models) {
      models = new Map();
      seen.set(b.agent, models);
    }
    models.set(b.model, (models.get(b.model) ?? 0) + b.turns);
  }
  const findings: DriftFinding[] = [];
  for (const [agent, models] of seen) {
    const configuredModel = wanted.get(agent)!;
    const target = catalogueIdForTranscriptModel(configuredModel) ?? configuredModel;
    for (const [observed, turns] of models) {
      if ((catalogueIdForTranscriptModel(observed) ?? observed) === target) continue;
      findings.push({
        agent,
        configuredModel,
        configuredLabel: labelForTranscriptModel(configuredModel),
        observedModel: observed,
        observedLabel: labelForTranscriptModel(observed),
        turns,
      });
    }
  }
  return findings.sort((a, b) => b.turns - a.turns);
}

// ---- Formatting ------------------------------------------------------------

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Dollars, with enough precision that a cheap model does not round to nothing. */
export function formatCost(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
