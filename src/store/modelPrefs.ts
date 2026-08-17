// Which models the composer's picker offers, in which order, and what a new
// conversation starts on. Persisted to localStorage with the same lightweight pattern as
// display.ts / composerBar.ts — pure UI arrangement, so it stays out of the SQLite
// metadata store (no Rust, no migration, no regenerated bindings).
//
// Two ideas carry the whole file:
//
//   • HIDDEN, not shown. The stored set is what the user REMOVED. A model added to the
//     catalogue by a later version then shows up on its own, instead of being invisible
//     until someone thinks to look for it. The factory set (FACTORY_HIDDEN_MODELS) is
//     just the seed for a user who has never touched the screen.
//
//   • Defaults are PER BACKEND. Claude and Codex seed a new conversation from their own
//     model + effort (a Claude alias would be rejected by the Codex binary and vice
//     versa), which is exactly how createConversationInRepo already branches.
import { create } from "zustand";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  FACTORY_HIDDEN_MODELS,
  modelOption,
  type ModelOption,
} from "../features/conversation/models";
import { clampEffort, effortLevelsForModel, type EffortLevel } from "../features/conversation/EffortGauge";
import type { BackendKind } from "./conversationsStore";

const STORAGE_KEY = "tosse:models";

/** Factory defaults — the product's answer when the user has expressed no preference. */
export const FACTORY_DEFAULTS = {
  claudeModel: "claude-opus-4-8",
  claudeEffort: "xhigh" as EffortLevel,
  codexModel: "gpt-5.6-sol",
  codexEffort: "xhigh" as EffortLevel,
} as const;

export interface ModelPrefsData {
  /** Model values removed from the picker. */
  hidden: string[];
  /** Model values in the user's manual order; anything absent keeps its catalogue rank. */
  order: string[];
  claudeModel: string;
  claudeEffort: EffortLevel;
  codexModel: string;
  codexEffort: EffortLevel;
}

interface ModelPrefsState extends ModelPrefsData {
  /** Show/hide one model in the picker. */
  setHidden: (value: string, hidden: boolean) => void;
  /** Replace the manual order (the full list of shown values, in order). */
  setOrder: (order: string[]) => void;
  /** Set a backend's default model (and re-clamp its effort to what that model takes). */
  setDefaultModel: (backend: BackendKind, value: string) => void;
  setDefaultEffort: (backend: BackendKind, effort: EffortLevel) => void;
  /** Back to the factory arrangement. */
  reset: () => void;
}

const factory = (): ModelPrefsData => ({
  hidden: [...FACTORY_HIDDEN_MODELS],
  order: [],
  claudeModel: FACTORY_DEFAULTS.claudeModel,
  claudeEffort: FACTORY_DEFAULTS.claudeEffort,
  codexModel: FACTORY_DEFAULTS.codexModel,
  codexEffort: FACTORY_DEFAULTS.codexEffort,
});

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Read the stored blob, keeping only what is still legal. A hand-edited or outdated
 * entry degrades to "that preference was dropped" rather than poisoning the picker —
 * and a stored default naming a model this version no longer knows falls back to the
 * factory one instead of seeding conversations with an id the binary would reject.
 */
export function normalize(raw: unknown): ModelPrefsData {
  const base = factory();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Partial<ModelPrefsData>;
  const known = (v: unknown, fallback: string, backend: BackendKind): string =>
    typeof v === "string" && modelOption(v)?.backend === backend ? v : fallback;
  const model = {
    claude: known(o.claudeModel, base.claudeModel, "claude"),
    codex: known(o.codexModel, base.codexModel, "codex"),
  };
  return {
    // `hidden` is only seeded when absent: an EMPTY stored array means the user showed
    // everything, which must not be re-seeded with the factory hiding on next launch.
    hidden: Array.isArray(o.hidden) ? strings(o.hidden) : base.hidden,
    order: strings(o.order),
    claudeModel: model.claude,
    codexModel: model.codex,
    // Effort is clamped to what the chosen model actually accepts, so a default carried
    // over from a model with a deeper ladder can't ask for a rung that model swallows.
    claudeEffort: clampEffort(effortOr(o.claudeEffort, base.claudeEffort), model.claude),
    codexEffort: clampEffort(effortOr(o.codexEffort, base.codexEffort), model.codex),
  };
}

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];
const effortOr = (v: unknown, fallback: EffortLevel): EffortLevel =>
  typeof v === "string" && (EFFORTS as string[]).includes(v) ? (v as EffortLevel) : fallback;

function load(): ModelPrefsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return factory();
  }
}

function save(data: ModelPrefsData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full / disabled: the arrangement still applies for this run.
  }
}

export const useModelPrefs = create<ModelPrefsState>((set, get) => ({
  ...load(),

  setHidden: (value, hidden) => {
    const cur = get().hidden;
    const next = hidden ? (cur.includes(value) ? cur : [...cur, value]) : cur.filter((v) => v !== value);
    if (next === cur) return;
    set({ hidden: next });
    persist(get());
    // Hiding the model a backend defaults to would leave new conversations seeded on a
    // model the picker no longer offers — move that default to the first one still shown.
    if (hidden) repairDefaults(set, get);
  },

  setOrder: (order) => {
    set({ order: [...order] });
    persist(get());
  },

  setDefaultModel: (backend, value) => {
    const key = backend === "codex" ? "codexModel" : "claudeModel";
    const effortKey = backend === "codex" ? "codexEffort" : "claudeEffort";
    set({ [key]: value, [effortKey]: clampEffort(get()[effortKey], value) } as Partial<ModelPrefsState>);
    persist(get());
  },

  setDefaultEffort: (backend, effort) => {
    const key = backend === "codex" ? "codexEffort" : "claudeEffort";
    const model = backend === "codex" ? get().codexModel : get().claudeModel;
    set({ [key]: clampEffort(effort, model) } as Partial<ModelPrefsState>);
    persist(get());
  },

  reset: () => {
    set(factory());
    persist(get());
  },
}));

function persist(s: ModelPrefsData) {
  save({
    hidden: s.hidden,
    order: s.order,
    claudeModel: s.claudeModel,
    claudeEffort: s.claudeEffort,
    codexModel: s.codexModel,
    codexEffort: s.codexEffort,
  });
}

/** Move a default off a model the user just hid. */
function repairDefaults(
  set: (partial: Partial<ModelPrefsState>) => void,
  get: () => ModelPrefsState,
) {
  const s = get();
  const patch: Partial<ModelPrefsData> = {};
  for (const backend of ["claude", "codex"] as const) {
    const key = backend === "codex" ? "codexModel" : "claudeModel";
    if (!s.hidden.includes(s[key])) continue;
    const fallback = fallbackModel(backend, s.hidden);
    if (fallback) patch[key] = fallback;
  }
  if (Object.keys(patch).length === 0) return;
  set(patch as Partial<ModelPrefsState>);
  persist(get());
}

/**
 * The first still-shown model of a backend — where a default lands when the one it named
 * gets hidden. Falls back to the factory model even if THAT is hidden: a conversation
 * must always spawn with a real model of its own backend, and a picker the user emptied
 * is not a reason to send nothing at all.
 */
function fallbackModel(backend: BackendKind, hidden: readonly string[]): string {
  const catalogue: ModelOption[] = backend === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
  const first = catalogue.find((m) => !hidden.includes(m.value));
  return first?.value ?? (backend === "codex" ? FACTORY_DEFAULTS.codexModel : FACTORY_DEFAULTS.claudeModel);
}

/** The model a new conversation on `backend` starts on. */
export function defaultModelFor(backend: BackendKind): string {
  const s = useModelPrefs.getState();
  return backend === "codex" ? s.codexModel : s.claudeModel;
}

/** The effort a new conversation on `backend` starts on, clamped to its model's ladder. */
export function defaultEffortFor(backend: BackendKind): EffortLevel {
  const s = useModelPrefs.getState();
  return backend === "codex" ? s.codexEffort : s.claudeEffort;
}

/** Effort rungs offerable as a default for `model` — the gauge's ladder, plus nothing:
 *  a model with no effort control (Haiku, anything 4.5 and older) gets an empty list and
 *  the Settings row says so instead of showing a picker that changes nothing. */
export function defaultEffortChoices(model: string): EffortLevel[] {
  return effortLevelsForModel(model);
}
