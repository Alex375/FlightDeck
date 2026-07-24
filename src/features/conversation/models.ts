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
}

// The real Claude models. Wire value = CLI alias (sent verbatim to set_model and used
// at spawn). Default = Opus 4.8. NO trailing hints: a context-window chip on Opus alone
// read as a per-model fact the other rows silently contradicted, and the real window is
// only known once a turn reports it (see the ContextMeter, which shows it for real).
export const CLAUDE_MODELS: ModelOption[] = [
  // Fable 5: preview model with its own rate-limit window (surfaced by the usage ring as
  // a model-scoped cap). Same effort tier as Opus. Alias "fable" is sent verbatim.
  { label: "Fable 5", value: "fable", backend: "claude" },
  { label: "Opus 4.8", value: "opus", backend: "claude" },
  { label: "Sonnet 4.6", value: "sonnet", backend: "claude" },
  { label: "Haiku 4.5", value: "haiku", backend: "claude" },
];

// The real Codex models, as reported by `codex app-server`'s `model/list`. STATIC
// fallback used while the dynamic list loads or on error — the live `model/list` (see
// codexModels.ts) supersedes it and picks up each model's real `supportedReasoningEfforts`.
// The gpt-5.6 family (sol/terra/luna) supports the deeper max+ultra effort rungs
// (assigned via effortLevelsForModel in codexModels.ts). The ids are the true wire ids,
// so a pick takes effect at `thread/start` (see the Rust `codex_model` plumbing).
export const CODEX_MODELS: ModelOption[] = [
  { label: "GPT-5.6 Sol", value: "gpt-5.6-sol", backend: "codex" },
  { label: "GPT-5.6 Terra", value: "gpt-5.6-terra", backend: "codex" },
  { label: "GPT-5.6 Luna", value: "gpt-5.6-luna", backend: "codex" },
  { label: "GPT-5.5", value: "gpt-5.5", backend: "codex" },
  { label: "GPT-5.4", value: "gpt-5.4", backend: "codex" },
  { label: "GPT-5.4 Mini", value: "gpt-5.4-mini", backend: "codex" },
];

/** The Codex backend's default model — seeds a Codex conversation so its persisted
 *  `model` is always a real Codex id (never a Claude alias the binary would reject).
 *  gpt-5.6-sol: the top current family (adds the max/ultra effort rungs) — the default pick. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export const ALL_MODELS: ModelOption[] = [...CLAUDE_MODELS, ...CODEX_MODELS];

/** Longest-first so `gpt-5.4-mini` matches before `gpt-5.4` in substring checks. */
const CODEX_BY_LEN = [...CODEX_MODELS].sort((a, b) => b.value.length - a.value.length);

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
  if (s.includes("opus")) return "Opus 4.8";
  if (s.includes("sonnet")) return "Sonnet 4.6";
  if (s.includes("haiku")) return "Haiku 4.5";
  if (s.includes("fable")) return "Fable 5";
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
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("fable")) return "fable";
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
  }: { locked: boolean; codexAvailable: boolean; codexModels?: ModelOption[] },
): { backend: BackendKind; label: string; models: ModelOption[] }[] {
  const groups: { backend: BackendKind; label: string; models: ModelOption[] }[] = [];
  // Show a backend's section when the conversation can still switch to it (fresh, and
  // — for Codex — the binary is installed) OR it is already ON that backend (so a
  // locked conversation always shows its own models, even if the other backend / a
  // now-missing Codex binary is unavailable — never an empty picker). The Codex list is
  // dynamic (`model/list`) when supplied, else the static fallback.
  const wantClaude = !locked || convKind === "claude";
  const wantCodex = (!locked && codexAvailable) || convKind === "codex";
  if (wantClaude) groups.push({ backend: "claude", label: "Claude", models: CLAUDE_MODELS });
  if (wantCodex) groups.push({ backend: "codex", label: "Codex", models: codexModels });
  return groups;
}
