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
//   • A model the user has never SEEN gets the factory treatment. `seen` records which
//     model each catalogue row ran when the prefs were last reconciled; a row that is new
//     — or an alias that has since moved on to a newer model — is shown or hidden as on a
//     fresh install (newest of its family: shown; older rows and Mythos: hidden). The
//     user's earlier choices keep applying to the models they were actually made about.
//
//   • Defaults are PER BACKEND. Claude and Codex seed a new conversation from their own
//     model + effort (a Claude alias would be rejected by the Codex binary and vice
//     versa), which is exactly how createConversationInRepo already branches.
import { create } from "zustand";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  FACTORY_CLAUDE_MODEL,
  FACTORY_HIDDEN_MODELS,
  modelIdentity,
  modelOption,
  type ModelOption,
} from "../features/conversation/models";
import { clampEffort, effortLevelsForModel, type EffortLevel } from "../features/conversation/EffortGauge";
import type { BackendKind } from "./conversationsStore";

const STORAGE_KEY = "tosse:models";

/** Factory defaults — the product's answer when the user has expressed no preference. */
export const FACTORY_DEFAULTS = {
  // The newest Opus — derived from the catalogue, so it follows the next release.
  claudeModel: FACTORY_CLAUDE_MODEL,
  claudeEffort: "xhigh" as EffortLevel,
  // Kept in step with DEFAULT_CODEX_MODEL: this is the one a NEW Codex conversation is
  // seeded from, that one is the safety fallback when a conv's model isn't a Codex id.
  codexModel: "gpt-6-astra",
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
  /** Catalogue value → the model it ran (its identity) when these prefs were last
   *  reconciled. How a model the user has never seen is told apart from one they chose
   *  to show or hide. */
  seen: Record<string, string>;
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

/** The static catalogue (both backends) — what `seen` tracks. The live Codex list is
 *  left out on purpose: none of its models is factory-hidden, so none needs tracking. */
const STATIC_CATALOGUE: readonly ModelOption[] = [...CLAUDE_MODELS, ...CODEX_MODELS];

const currentSeen = (): Record<string, string> =>
  Object.fromEntries(STATIC_CATALOGUE.map((m) => [m.value, modelIdentity(m)]));

/**
 * What a blob written BEFORE `seen` existed had seen: the Claude catalogue as it stood,
 * each alias on the model its row was LABELLED as then (`opus` read "Opus 5"). Frozen —
 * it describes the past and must not follow later catalogue edits. Codex rows are absent:
 * none is factory-hidden, so an unseen one just stays shown, as it always did.
 */
const LEGACY_SEEN: Readonly<Record<string, string>> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-opus-4-1": "claude-opus-4-1",
  "claude-opus-4-0": "claude-opus-4-0",
  sonnet: "claude-sonnet-5",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-sonnet-4-0": "claude-sonnet-4-0",
  "claude-3-7-sonnet": "claude-3-7-sonnet",
  "claude-3-5-sonnet": "claude-3-5-sonnet",
  haiku: "claude-haiku-4-5",
  "claude-3-5-haiku": "claude-3-5-haiku",
  "claude-mythos-5": "claude-mythos-5",
};

const factory = (): ModelPrefsData => ({
  hidden: [...FACTORY_HIDDEN_MODELS],
  order: [],
  claudeModel: FACTORY_DEFAULTS.claudeModel,
  claudeEffort: FACTORY_DEFAULTS.claudeEffort,
  codexModel: FACTORY_DEFAULTS.codexModel,
  codexEffort: FACTORY_DEFAULTS.codexEffort,
  seen: currentSeen(),
});

/**
 * Give every catalogue row the user has not seen the factory treatment, then mark the
 * whole catalogue seen. A row is unseen when its value is new, or when it is an alias
 * that now runs a different model than the one the user last saw under it.
 *
 *  - Factory-hidden (an older version, Mythos) → hidden, as on a fresh install.
 *  - Factory-shown (the newest of its family) → shown. A brand-new value already is; a
 *    MOVED alias has its old hide lifted — that hide was about the previous model, which
 *    now has a pinned row of its own.
 *
 * Pure. A row the user hid while it ran the same model it runs now stays hidden.
 */
export function reconcileSeen(
  hidden: readonly string[],
  seen: Readonly<Record<string, string>>,
): { hidden: string[]; seen: Record<string, string> } {
  const next = new Set(hidden);
  const factoryHidden = new Set(FACTORY_HIDDEN_MODELS);
  for (const m of STATIC_CATALOGUE) {
    const was = seen[m.value];
    if (was === modelIdentity(m)) continue;
    if (factoryHidden.has(m.value)) next.add(m.value);
    else if (was !== undefined) next.delete(m.value);
  }
  // Already-hidden values keep their stored order; newly hidden ones follow.
  const kept = hidden.filter((v) => next.has(v));
  const added = [...next].filter((v) => !hidden.includes(v));
  return { hidden: [...kept, ...added], seen: currentSeen() };
}

const seenMap = (v: unknown): Record<string, string> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : null;

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
  // `hidden` is only seeded when absent: an EMPTY stored array means the user showed
  // everything, which must not be re-seeded with the factory hiding on next launch.
  // A blob without `seen` predates it — it saw the catalogue LEGACY_SEEN describes.
  const { hidden, seen } = Array.isArray(o.hidden)
    ? reconcileSeen(strings(o.hidden), seenMap(o.seen) ?? LEGACY_SEEN)
    : { hidden: base.hidden, seen: base.seen };
  return {
    hidden,
    seen,
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
    if (!raw) return factory();
    const parsed = JSON.parse(raw);
    const data = normalize(parsed);
    // Write the reconciliation back, so the next catalogue change is measured from what
    // this version showed — not from a snapshot several releases old.
    const before = JSON.stringify([parsed?.hidden, parsed?.seen]);
    if (JSON.stringify([data.hidden, data.seen]) !== before) save(data);
    return data;
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
    seen: s.seen,
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
