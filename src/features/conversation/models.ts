import type { BackendKind } from "../../store/conversationsStore";

/**
 * The unified model catalogue for the composer's picker. It spans BOTH backends —
 * choosing a model IS how the backend is chosen (a Codex model ⇒ a Codex
 * conversation). The backend is fixed at creation (formats are incompatible), so the
 * picker only offers cross-backend models while a conversation is FRESH; once the
 * first message spawns it, the picker locks to the current backend (see
 * `modelsForPicker`). Backend is carried on each option so a pick can flip
 * `conv.kind` in one shot.
 */
export interface ModelOption {
  /** Display label (matches the CLI's own naming). */
  label: string;
  /** Wire value — the alias/id sent verbatim to the backend at spawn. */
  value: string;
  backend: BackendKind;
  /**
   * The reasoning-effort capability tokens the CLI's OWN model registry declares for
   * this model (`capabilities:[…]` — see CLAUDE_MODELS). `effort` unlocks low/medium/
   * high, `max_effort` adds "max", `xhigh_effort` adds "xhigh"; a model declaring none
   * has no effort control at all. Absent = unknown (a dynamic Codex model, which
   * reports its own `supportedReasoningEfforts` instead). Read by `effortLevelsForModel`.
   */
  caps?: readonly ModelCap[];
  /** Who serves the model — shown as a column in Settings → Models. */
  provider?: ModelProvider;
}

/** Effort capability tokens, verbatim from the CLI registry's `capabilities` array. */
export type ModelCap = "effort" | "max_effort" | "xhigh_effort";

export type ModelProvider = "Anthropic" | "OpenAI";

// Effort ladders, named once so the catalogue below reads as data. These are the CLI
// registry's own `capabilities` arrays, trimmed to the effort tokens.
const FULL: readonly ModelCap[] = ["effort", "max_effort", "xhigh_effort"]; // low→max
const NO_XHIGH: readonly ModelCap[] = ["effort", "max_effort"]; // low/medium/high + max
const NO_EFFORT: readonly ModelCap[] = []; // no effort control at all

/**
 * Every Claude model the CLI knows, transcribed from the model registry BAKED INTO the
 * binary (2.1.233 — a plain `{id,family,display_name,capabilities,default_effort,…}`
 * array). That registry is the authority for two things we used to guess at:
 *   • the effort ladder (`caps`) — which is how we learn that Opus 4.6 and Sonnet 4.6
 *     take `max` but NOT `xhigh`, and that everything at 4.5 and below has no effort
 *     control whatsoever. A family-name heuristic could never get that right.
 *   • the exact display names, so a row here reads like the CLI's own `/model` picker.
 *
 * Wire value = the CLI alias for the LATEST of a family (`opus`, `sonnet`, `haiku`,
 * `fable`, resolved by the registry's `aliases` table), and the FULL model name for
 * every pinned older version — an alias always follows the newest release, so it can't
 * name a specific one. `--model` accepts both.
 *
 * Only the first few are shown out of the box; the rest are opt-in from
 * Settings → Models (see FACTORY_HIDDEN_MODELS). Ordered newest-family-first, and
 * newest-version-first inside a family — that IS the default picker order.
 */
export const CLAUDE_MODELS: ModelOption[] = [
  // Fable 5: preview model with its own rate-limit window (surfaced by the usage ring as
  // a model-scoped cap). Same effort tier as Opus. Alias "fable" is sent verbatim.
  { label: "Fable 5", value: "fable", backend: "claude", caps: FULL, provider: "Anthropic" },
  { label: "Opus 5", value: "opus", backend: "claude", caps: FULL, provider: "Anthropic" },
  // Opus 4.8: the app's default (see DEFAULT_MODEL). Named in full because `opus` now
  // resolves to Opus 5. Verified live: a turn spawned with `--model claude-opus-4-8`
  // reports `claude-opus-4-8` in its modelUsage.
  { label: "Opus 4.8", value: "claude-opus-4-8", backend: "claude", caps: FULL, provider: "Anthropic" },
  { label: "Opus 4.7", value: "claude-opus-4-7", backend: "claude", caps: FULL, provider: "Anthropic" },
  { label: "Opus 4.6", value: "claude-opus-4-6", backend: "claude", caps: NO_XHIGH, provider: "Anthropic" },
  { label: "Opus 4.5", value: "claude-opus-4-5", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Opus 4.1", value: "claude-opus-4-1", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Opus 4", value: "claude-opus-4-0", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Sonnet 5", value: "sonnet", backend: "claude", caps: FULL, provider: "Anthropic" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6", backend: "claude", caps: NO_XHIGH, provider: "Anthropic" },
  { label: "Sonnet 4.5", value: "claude-sonnet-4-5", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Sonnet 4", value: "claude-sonnet-4-0", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Sonnet 3.7", value: "claude-3-7-sonnet", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Sonnet 3.5", value: "claude-3-5-sonnet", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Haiku 4.5", value: "haiku", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  { label: "Haiku 3.5", value: "claude-3-5-haiku", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
  // Mythos 5: in the registry with NO provider ids beyond first-party and no
  // capabilities — listed for completeness, hidden by default like the rest.
  { label: "Mythos 5", value: "claude-mythos-5", backend: "claude", caps: NO_EFFORT, provider: "Anthropic" },
];

/**
 * What the picker shows on a fresh install: Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5 —
 * one current model per family, with Opus 4.8 as the default. Everything else (Opus 5
 * included, by explicit product decision) starts in Settings → Models' "Available"
 * list, one click away.
 *
 * Stored as the HIDDEN set rather than the shown one, on purpose: a model added to the
 * catalogue later then appears on its own instead of staying invisible until someone
 * notices. The user's own choices are persisted the same way (see store/modelPrefs).
 */
export const FACTORY_HIDDEN_MODELS: readonly string[] = CLAUDE_MODELS.map((m) => m.value).filter(
  (v) => !["fable", "claude-opus-4-8", "sonnet", "haiku"].includes(v),
);

// The real Codex models, as reported by `codex app-server`'s `model/list`. STATIC
// fallback used while the dynamic list loads or on error — the live `model/list` (see
// codexModels.ts) supersedes it and picks up each model's real `supportedReasoningEfforts`.
// The gpt-5.6 family (sol/terra/luna) supports the deeper max+ultra effort rungs
// (assigned via effortLevelsForModel in codexModels.ts). The ids are the true wire ids,
// so a pick takes effect at `thread/start` (see the Rust `codex_model` plumbing).
export const CODEX_MODELS: ModelOption[] = [
  { label: "GPT-5.6 Sol", value: "gpt-5.6-sol", backend: "codex", provider: "OpenAI" },
  { label: "GPT-5.6 Terra", value: "gpt-5.6-terra", backend: "codex", provider: "OpenAI" },
  { label: "GPT-5.6 Luna", value: "gpt-5.6-luna", backend: "codex", provider: "OpenAI" },
  { label: "GPT-5.5", value: "gpt-5.5", backend: "codex", provider: "OpenAI" },
  { label: "GPT-5.4", value: "gpt-5.4", backend: "codex", provider: "OpenAI" },
  { label: "GPT-5.4 Mini", value: "gpt-5.4-mini", backend: "codex", provider: "OpenAI" },
];

/** The Codex backend's default model — seeds a Codex conversation so its persisted
 *  `model` is always a real Codex id (never a Claude alias the binary would reject).
 *  gpt-5.6-sol: the top current family (adds the max/ultra effort rungs) — the default pick. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export const ALL_MODELS: ModelOption[] = [...CLAUDE_MODELS, ...CODEX_MODELS];

/** Longest-first so `gpt-5.4-mini` matches before `gpt-5.4` in substring checks. */
const CODEX_BY_LEN = [...CODEX_MODELS].sort((a, b) => b.value.length - a.value.length);

/** Same, for Claude: a resolved id contains BOTH a full model name and the family
 *  alias (`claude-opus-4-8[1m]` contains "claude-opus-4-8" AND "opus"), so the longest
 *  value has to win — otherwise Opus 4.8 would read as "Opus 5". Driving the label /
 *  family lookups off the catalogue (rather than a hand-written ladder) also means
 *  adding a model stays a one-line edit above. */
const CLAUDE_BY_LEN = [...CLAUDE_MODELS].sort((a, b) => b.value.length - a.value.length);

/**
 * Which backend a model id belongs to. Matches an exact catalogue value first, then
 * falls back to family heuristics so a RESOLVED live id also classifies (Claude
 * reports e.g. `claude-opus-4-8[1m]`; Codex reports `gpt-5.5`). Defaults to "claude"
 * — the app's default backend and the pre-Codex behaviour for any unknown id.
 */
export function backendOfModel(id?: string | null): BackendKind {
  if (!id) return "claude";
  const s = id.toLowerCase();
  const exact = ALL_MODELS.find((m) => m.value === s);
  if (exact) return exact.backend;
  if (CODEX_BY_LEN.some((m) => s.includes(m.value)) || /\bgpt|codex|^o\d/.test(s)) return "codex";
  return "claude";
}

/** Pretty label for a model id (matches a catalogue label; falls back per family so a
 *  resolved live id still reads well). */
export function modelLabel(id?: string | null): string {
  if (!id) return "Model";
  const s = id.toLowerCase();
  const exact = ALL_MODELS.find((m) => m.value === s);
  if (exact) return exact.label;
  const claude = CLAUDE_BY_LEN.find((m) => s.includes(m.value));
  if (claude) return claude.label;
  const codex = CODEX_BY_LEN.find((m) => s.includes(m.value));
  if (codex) return codex.label;
  return id;
}

/** Map any model id (a UI alias OR a resolved id) to its picker VALUE so the menu can
 *  highlight the live model even when the core reports a long resolved id. */
export function modelFamily(id?: string | null): string | null {
  if (!id) return null;
  const s = id.toLowerCase();
  const exact = ALL_MODELS.find((m) => m.value === s);
  if (exact) return exact.value;
  const codex = CODEX_BY_LEN.find((m) => s.includes(m.value));
  if (codex) return codex.value;
  const claude = CLAUDE_BY_LEN.find((m) => s.includes(m.value));
  if (claude) return claude.value;
  return null;
}

/**
 * The models to OFFER in the picker for a conversation.
 *  - `locked` (a message has been sent → backend engaged): only the current
 *    backend's models — the backend can't change mid-conversation.
 *  - fresh + Codex installed: both backends, so the pick chooses the backend.
 *  - fresh + no Codex: Claude only.
 * Returned grouped by backend (Claude first) so the menu can render sections.
 */
export function modelsForPicker(
  convKind: BackendKind,
  {
    locked,
    codexAvailable,
    codexModels = CODEX_MODELS,
    hidden,
    order,
    current,
  }: {
    locked: boolean;
    codexAvailable: boolean;
    codexModels?: ModelOption[];
    /** Values the user removed from the picker (Settings → Models). */
    hidden?: Iterable<string>;
    /** Values in the user's manual order; anything absent keeps its catalogue rank. */
    order?: readonly string[];
    /** The model this conversation is ON — kept in the menu even when hidden, so a
     *  conversation started before the model was hidden can still see (and get back to)
     *  what it is running. Accepts a resolved live id. */
    current?: string | null;
  } = { locked: false, codexAvailable: false },
): { backend: BackendKind; label: string; models: ModelOption[] }[] {
  const groups: { backend: BackendKind; label: string; models: ModelOption[] }[] = [];
  // Show a backend's section when the conversation can still switch to it (fresh, and
  // — for Codex — the binary is installed) OR it is already ON that backend (so a
  // locked conversation always shows its own models, even if the other backend / a
  // now-missing Codex binary is unavailable — never an empty picker). The Codex list is
  // dynamic (`model/list`) when supplied, else the static fallback.
  //
  // The CLAUDE list stays deliberately STATIC, even though the binary can report its own
  // catalogue (`list_models`, wired on the Rust side): what it returns is a menu meant
  // for the CLI — a "Default (recommended)" entry, plus the same model listed twice under
  // its alias and its 1M variant. CLAUDE_MODELS is transcribed from the binary's own
  // registry instead, which gives the same coverage in rows we control (and carries each
  // model's effort capabilities). Which of those rows a user actually sees is their call
  // — Settings → Models, applied here via `hidden`/`order`.
  const wantClaude = !locked || convKind === "claude";
  const wantCodex = (!locked && codexAvailable) || convKind === "codex";
  // Never hide the model the conversation is actually running.
  const keep = current ? modelFamily(current) : null;
  const hide = new Set(hidden ?? []);
  if (keep) hide.delete(keep);
  const shown = (models: ModelOption[]) => visibleModels(models, hide, order);
  if (wantClaude) groups.push({ backend: "claude", label: "Claude", models: shown(CLAUDE_MODELS) });
  if (wantCodex) groups.push({ backend: "codex", label: "Codex", models: shown(codexModels) });
  // A section that filtered down to nothing would render as an empty heading; drop it.
  // Both sections empty can't strand the user: Settings → Models is where they came from.
  return groups.filter((g) => g.models.length > 0);
}

/**
 * Apply the user's picker choices to a catalogue: drop `hidden`, then sort by `order`.
 * Pure, and the single place the two live — the Settings screen and the composer's menu
 * must agree on both, down to the ordering of a model the user never dragged.
 *
 * Values absent from `order` keep their catalogue position by sorting AFTER the ordered
 * ones: a newly added model appears at the end of the list rather than jumping to the
 * top of an arrangement the user made by hand.
 */
export function visibleModels(
  models: readonly ModelOption[],
  hidden?: Iterable<string>,
  order?: readonly string[],
): ModelOption[] {
  const hide = hidden instanceof Set ? hidden : new Set(hidden ?? []);
  const shown = models.filter((m) => !hide.has(m.value));
  if (!order || order.length === 0) return shown;
  const rank = new Map(order.map((v, i) => [v, i]));
  return shown
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ra = rank.get(a.m.value);
      const rb = rank.get(b.m.value);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.i - b.i; // both unranked → catalogue order, stable
    })
    .map((x) => x.m);
}

/** Look a model up in the static catalogue (exact value). */
export function modelOption(value: string): ModelOption | undefined {
  return ALL_MODELS.find((m) => m.value === value);
}
