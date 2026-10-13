// Turning raw Claude turns — each conversation's main agent and its helpers — into money
// and shapes. All of it pure, so the numbers on both dashboards (the usage overview and
// the helpers page) are testable without a filesystem, a chart, or a render.
//
// Four jobs live here:
//   1. matching a transcript's model id to the app's model catalogue (harder than it
//      looks — see `catalogueIdForTranscriptModel`),
//   2. costing a bucket against an EDITABLE rate card,
//   3. telling the main agent's turns from its helpers' (`roleOf`),
//   4. pivoting the flat bucket list into the rows and series the tables and charts want.
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
  opus: { input: 4, output: 20 }, // Opus 5.5 — the registry's `tier_4_20`
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  sonnet: { input: 2, output: 10 }, // Sonnet 5.5 — the registry's `tier_2_10`
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
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

// ---- Roles: the main agent vs its helpers ----------------------------------

/**
 * Who did the work: the conversation's own agent, a helper it delegated to, or a helper
 * running inside a workflow. Ordered by delegation depth — the charts stack them in this
 * order and shade them along it (see `hueForRole`).
 */
export type SpendRole = "main" | "helper" | "workflow";

export const ROLE_ORDER: readonly SpendRole[] = ["main", "helper", "workflow"];

export const ROLE_LABELS: Record<SpendRole, string> = {
  main: "Main agents",
  helper: "Helpers",
  workflow: "Workflow helpers",
};

export function roleOf(bucket: SpendBucket): SpendRole {
  if (bucket.thread === "main") return "main";
  return bucket.workflow ? "workflow" : "helper";
}

/**
 * Only the helpers' turns — what the Helpers page reports. The scan returns the main
 * agents too; without this filter that page's "what the helpers cost" would quietly
 * become "what Claude cost".
 */
export function helperBuckets(buckets: SpendBucket[]): SpendBucket[] {
  return buckets.filter((b) => b.thread === "helper");
}

/** Everything the role comparison table says about one role. */
export interface RoleSummary {
  role: SpendRole;
  label: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** `null` when at least one contributing model has no price on the card. */
  cost: number | null;
  /** Mean prompt size per turn — uncached + cache-read + cache-written input. This is the
   *  figure that explains why a main agent costs more per turn than a helper: it carries
   *  the whole conversation every time, where a helper starts from a short brief. */
  contextPerTurn: number;
  /** Share of that prompt served from cache, 0‥1; `null` with no input at all. */
  cacheReuse: number | null;
}

/** One row per role, in `ROLE_ORDER`, every role present even at zero — a missing row
 *  would read as "not measured" rather than as "none". */
export function summarizeByRole(buckets: SpendBucket[], card: RateCard): RoleSummary[] {
  const rows = new Map<SpendRole, RoleSummary & { unpriced: boolean }>(
    ROLE_ORDER.map((role) => [
      role,
      {
        role,
        label: ROLE_LABELS[role],
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cost: 0,
        contextPerTurn: 0,
        cacheReuse: null,
        unpriced: false,
      },
    ]),
  );
  for (const b of buckets) {
    const row = rows.get(roleOf(b))!;
    row.turns += b.turns;
    row.inputTokens += b.input_tokens;
    row.outputTokens += b.output_tokens;
    row.cacheReadTokens += b.cache_read_tokens;
    row.cacheCreationTokens += b.cache_creation_tokens;
    const cost = costOfBucket(b, card);
    if (cost === null) row.unpriced = true;
    else if (row.cost !== null) row.cost += cost;
  }
  return ROLE_ORDER.map((role) => {
    const { unpriced, ...row } = rows.get(role)!;
    const prompt = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    return {
      ...row,
      cost: unpriced ? null : row.cost,
      contextPerTurn: row.turns > 0 ? prompt / row.turns : 0,
      cacheReuse: prompt > 0 ? row.cacheReadTokens / prompt : null,
    };
  });
}

/** One line of the "main vs helpers" breakdown table. */
export interface SplitRow {
  key: string;
  label: string;
  /** The absolute repo path for a folder row — shown on hover. */
  detail?: string;
  mainOutput: number;
  /** Helpers, workflow helpers included. */
  helperOutput: number;
  turns: number;
  /** `null` when at least one contributing model has no price on the card. */
  cost: number | null;
  /** Helpers' share of the row's output tokens, 0‥1; `null` for an empty row. */
  helperShare: number | null;
}

/**
 * Main agents vs helpers for each model or each folder, biggest first. The share is of
 * OUTPUT tokens — a share of cost would mix in the price gap between the models each role
 * runs on, and answer "which role runs pricier models" instead of "who does the work".
 */
export function splitByRole(
  buckets: SpendBucket[],
  by: "model" | "repo",
  card: RateCard,
): SplitRow[] {
  const rows = new Map<string, SplitRow & { unpriced: boolean }>();
  for (const b of buckets) {
    const key = by === "model" ? b.model : b.repo;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        label: by === "model" ? labelForTranscriptModel(b.model) : b.repo_label,
        detail: by === "repo" ? b.repo : undefined,
        mainOutput: 0,
        helperOutput: 0,
        turns: 0,
        cost: 0,
        helperShare: null,
        unpriced: false,
      };
      rows.set(key, row);
    }
    if (b.thread === "main") row.mainOutput += b.output_tokens;
    else row.helperOutput += b.output_tokens;
    row.turns += b.turns;
    const cost = costOfBucket(b, card);
    if (cost === null) row.unpriced = true;
    else if (row.cost !== null) row.cost += cost;
  }
  return [...rows.values()]
    .map(({ unpriced, ...row }) => {
      const out = row.mainOutput + row.helperOutput;
      return { ...row, cost: unpriced ? null : row.cost, helperShare: out > 0 ? row.helperOutput / out : null };
    })
    .sort((a, b) => b.mainOutput + b.helperOutput - (a.mainOutput + a.helperOutput));
}

/** `part / whole`, or `null` when there is no whole to take a share of. */
export function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export function formatShare(share: number | null): string {
  if (share === null) return "—";
  // Never round a sliver to its neighbour: "0%" next to a non-empty bar, or "100%" when the
  // other side did something, both say the opposite of the data.
  if (share > 0 && share < 0.01) return "<1%";
  if (share < 1 && share > 0.99) return ">99%";
  return `${Math.round(share * 100)}%`;
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
  return dailySeries(buckets, card, metric, "model");
}

/**
 * Daily totals per model or per role. Models stack biggest first; roles stack in
 * `ROLE_ORDER` whatever their size — the main agent is the baseline every day, so a day's
 * delegation reads as what sits on top of it.
 */
export function dailySeries(
  buckets: SpendBucket[],
  card: RateCard,
  metric: "cost" | "output",
  by: "model" | "role",
): DaySeries {
  if (buckets.length === 0) return { days: [], series: [] };
  const sorted = [...buckets].sort((a, b) => a.day.localeCompare(b.day));
  const days = continuousDays(sorted[0]!.day, sorted[sorted.length - 1]!.day);
  const index = new Map(days.map((d, i) => [d, i]));
  const byKey = new Map<string, number[]>();
  for (const b of buckets) {
    const i = index.get(b.day);
    if (i === undefined) continue;
    const key = by === "model" ? b.model : roleOf(b);
    let values = byKey.get(key);
    if (!values) {
      values = new Array(days.length).fill(0);
      byKey.set(key, values);
    }
    values[i] += metric === "cost" ? (costOfBucket(b, card) ?? 0) : b.output_tokens;
  }
  const series = [...byKey.entries()].map(([key, values]) => ({
    key,
    label: by === "model" ? labelForTranscriptModel(key) : ROLE_LABELS[key as SpendRole],
    values,
  }));
  if (by === "model") series.sort((a, b) => sum(b.values) - sum(a.values));
  else series.sort((a, b) => ROLE_ORDER.indexOf(a.key as SpendRole) - ROLE_ORDER.indexOf(b.key as SpendRole));
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

/** One model's share of a repo's output or cost. In cost, `unpriced` parts carry `value: 0`
 *  for layout only — the chart must show them as "no price", never as $0. In output tokens
 *  nothing is ever unpriced. */
export interface RepoModelPart {
  key: string;
  label: string;
  value: number;
  unpriced: boolean;
}

/**
 * What a bar chart measures. Output tokens by default — the volume of work, comparable
 * without a price list; API cost on request, which weighs each token by its model's rate.
 */
export type BarMetric = "output" | "cost";

/** Model mix per repo, as absolute values — the caller decides whether to normalise. */
export function modelsByRepo(
  buckets: SpendBucket[],
  card: RateCard,
  metric: BarMetric = "cost",
): Array<{ repo: string; label: string; total: number; parts: RepoModelPart[] }> {
  return breakdown(buckets, "repo", "model", card, metric).map(({ key, ...row }) => ({
    repo: key,
    ...row,
  }));
}

/**
 * Output tokens or API cost per row, split into parts — per folder or per role, by model or
 * by role. Rows are biggest first; model parts biggest first, role parts in `ROLE_ORDER`
 * (the same stacking as the daily chart, so a shade sits at the same place in every bar).
 */
export function breakdown(
  buckets: SpendBucket[],
  rowsBy: "repo" | "role",
  partsBy: "model" | "role",
  card: RateCard,
  metric: BarMetric,
): Array<{ key: string; label: string; total: number; parts: RepoModelPart[] }> {
  const rows = new Map<string, { label: string; parts: Map<string, RepoModelPart> }>();
  for (const b of buckets) {
    const role = roleOf(b);
    const rowKey = rowsBy === "repo" ? b.repo : role;
    let entry = rows.get(rowKey);
    if (!entry) {
      entry = { label: rowsBy === "repo" ? b.repo_label : ROLE_LABELS[role], parts: new Map() };
      rows.set(rowKey, entry);
    }
    const partKey = partsBy === "model" ? b.model : role;
    let part = entry.parts.get(partKey);
    if (!part) {
      part = {
        key: partKey,
        label: partsBy === "model" ? labelForTranscriptModel(b.model) : ROLE_LABELS[role],
        value: 0,
        unpriced: false,
      };
      entry.parts.set(partKey, part);
    }
    if (metric === "output") {
      part.value += b.output_tokens;
      continue;
    }
    const cost = costOfBucket(b, card);
    // Carried, not folded to 0: a folder whose helpers all ran on an unpriced model would
    // otherwise read as "$0", the exact impression `costOfBucket` returns null to prevent.
    if (cost === null) part.unpriced = true;
    else part.value += cost;
  }
  const roleRank = (key: string) => ROLE_ORDER.indexOf(key as SpendRole);
  return [...rows.entries()]
    .map(([key, { label, parts }]) => {
      const list = [...parts.values()].sort((a, b) =>
        partsBy === "role" ? roleRank(a.key) - roleRank(b.key) : b.value - a.value,
      );
      return { key, label, total: sum(list.map((p) => p.value)), parts: list };
    })
    .sort((a, b) =>
      rowsBy === "role" ? roleRank(a.key) - roleRank(b.key) : b.total - a.total,
    );
}

/**
 * Every pricing key the report actually contains that the card has no rate for — the list
 * the price editor must offer, or an unpriced model could never be given a price.
 */
export function unpricedKeys(buckets: SpendBucket[], card: RateCard): string[] {
  const keys = new Set<string>();
  for (const b of buckets) {
    const key = pricingKeyForTranscriptModel(b.model);
    if (!card.rates[key]) keys.add(key);
  }
  return [...keys].sort();
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
  /** The day the setting was last changed, when known — shown so the reader can see the
   *  window the finding is drawn from. */
  since: string | null;
}

/** `YYYY-MM-DD` for an epoch-millisecond stamp, in UTC — the clock the transcripts use. */
export function dayOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Find agents whose recent turns ran on a model other than the one they are configured for.
 *
 * Compares CATALOGUE ids, not raw strings — `haiku` and `claude-haiku-4-5-20251001` are the
 * same model written two ways, and reporting that as drift would cry wolf on every correctly
 * configured agent.
 *
 * Rows that cannot disagree are left out rather than compared:
 *   - `overriddenByForce` — with the budget locked every run uses the forced model, so the
 *     row's own setting is not supposed to take effect;
 *   - no model, or `inherit` — "follow the conversation" names no model to contradict.
 *
 * ⚠️ A finding is not proof the setting is broken: a `model` passed at spawn time (by
 * Claude, or by a workflow) outranks the definition by design. The UI words it as an
 * observation, not an accusation.
 */
export function findDrift(
  buckets: SpendBucket[],
  configured: Array<{
    name: string;
    model: string | null;
    configuredAtMs?: number | null;
    overriddenByForce?: boolean;
  }>,
): DriftFinding[] {
  const wanted = new Map(
    configured
      .filter(
        (c): c is typeof c & { model: string } =>
          !!c.model && c.model !== "inherit" && !c.overriddenByForce,
      )
      .map((c) => [c.name, c]),
  );
  const seen = new Map<string, Map<string, number>>();
  for (const b of buckets) {
    const want = wanted.get(b.agent);
    if (!want) continue;
    // Only turns that ran AFTER the setting was last changed can say anything about it.
    // Without this the canary fires the moment you pick a model, because the week behind
    // you ran on the old one — a false alarm at exactly the moment it destroys trust.
    // Strictly after the day of the change: a same-day turn may well predate it, and one
    // day of silence costs far less than one wrong accusation.
    if (want.configuredAtMs != null && b.day <= dayOfMs(want.configuredAtMs)) continue;
    let models = seen.get(b.agent);
    if (!models) {
      models = new Map();
      seen.set(b.agent, models);
    }
    models.set(b.model, (models.get(b.model) ?? 0) + b.turns);
  }
  const findings: DriftFinding[] = [];
  for (const [agent, models] of seen) {
    const want = wanted.get(agent)!;
    const target = catalogueIdForTranscriptModel(want.model) ?? want.model;
    for (const [observed, turns] of models) {
      if ((catalogueIdForTranscriptModel(observed) ?? observed) === target) continue;
      findings.push({
        agent,
        configuredModel: want.model,
        configuredLabel: labelForTranscriptModel(want.model),
        observedModel: observed,
        observedLabel: labelForTranscriptModel(observed),
        turns,
        since: want.configuredAtMs != null ? dayOfMs(want.configuredAtMs) : null,
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
