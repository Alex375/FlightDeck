// The rate card the sub-agent spend dashboard costs everything against — editable, and
// persisted to localStorage next to the other display preferences.
//
// Prices are DATA, not constants compiled into a formula: Anthropic's rate card changes,
// a new model appears, and neither should need a release to show correct numbers. The
// factory values live in `spend.ts` (DEFAULT_RATES); this store holds the user's overrides
// and merges them on top, so a model added to the defaults later still gets its price
// without anyone touching their saved settings.
//
// ⚠️ These figures are API rates. On a Claude subscription nothing here is billed — the UI
// says so on the page itself, not just in this comment.
import { create } from "zustand";

import {
  DEFAULT_CACHE_RATIOS,
  DEFAULT_RATES,
  type CacheRatios,
  type ModelRate,
  type RateCard,
} from "../features/settings/claudecode/spend";

const STORAGE_KEY = "tosse:pricing";

interface PricingState {
  /** Only what the user changed — merged over the factory defaults on read. */
  overrides: Record<string, ModelRate>;
  cache: CacheRatios;
  setRate: (modelKey: string, rate: ModelRate) => void;
  clearRate: (modelKey: string) => void;
  setCacheRatios: (cache: CacheRatios) => void;
  resetAll: () => void;
}

interface Persisted {
  overrides?: Record<string, ModelRate>;
  cache?: CacheRatios;
}

/** A finite, non-negative number, or `null`. Guards against a hand-edited localStorage
 *  entry turning every cost on the page into `NaN`. */
function cleanNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function cleanRate(value: unknown): ModelRate | null {
  if (!value || typeof value !== "object") return null;
  const input = cleanNumber((value as ModelRate).input);
  const output = cleanNumber((value as ModelRate).output);
  return input === null || output === null ? null : { input, output };
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Persisted;
    const overrides: Record<string, ModelRate> = {};
    for (const [key, value] of Object.entries(parsed.overrides ?? {})) {
      const rate = cleanRate(value);
      if (rate) overrides[key] = rate;
    }
    const read = cleanNumber(parsed.cache?.read);
    const write = cleanNumber(parsed.cache?.write);
    return {
      overrides,
      cache:
        read === null || write === null ? { ...DEFAULT_CACHE_RATIOS } : { read, write },
    };
  } catch {
    // A private window, cleared site data, or a corrupt entry: fall back to the factory
    // card rather than showing a broken page.
    return {};
  }
}

function persist(state: Pick<PricingState, "overrides" | "cache">) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ overrides: state.overrides, cache: state.cache }),
    );
  } catch {
    // Storage can throw (private mode, quota). The session keeps the edit in memory.
  }
}

const initial = load();

export const useSubagentPricing = create<PricingState>((set, get) => ({
  overrides: initial.overrides ?? {},
  cache: initial.cache ?? { ...DEFAULT_CACHE_RATIOS },
  setRate: (modelKey, rate) => {
    const overrides = { ...get().overrides, [modelKey]: rate };
    set({ overrides });
    persist({ overrides, cache: get().cache });
  },
  clearRate: (modelKey) => {
    const overrides = { ...get().overrides };
    delete overrides[modelKey];
    set({ overrides });
    persist({ overrides, cache: get().cache });
  },
  setCacheRatios: (cache) => {
    set({ cache });
    persist({ overrides: get().overrides, cache });
  },
  resetAll: () => {
    const cache = { ...DEFAULT_CACHE_RATIOS };
    set({ overrides: {}, cache });
    persist({ overrides: {}, cache });
  },
}));

/**
 * The effective rate card: factory defaults with the user's overrides on top.
 *
 * Merged on READ rather than stored merged, so a model added to `DEFAULT_RATES` in a later
 * version appears with its price for everyone — including users who have already saved an
 * override for something else.
 */
export function useRateCard(): RateCard {
  const overrides = useSubagentPricing((s) => s.overrides);
  const cache = useSubagentPricing((s) => s.cache);
  return { rates: { ...DEFAULT_RATES, ...overrides }, cache };
}

/** Non-reactive read, for code outside a component. */
export function rateCard(): RateCard {
  const { overrides, cache } = useSubagentPricing.getState();
  return { rates: { ...DEFAULT_RATES, ...overrides }, cache };
}
