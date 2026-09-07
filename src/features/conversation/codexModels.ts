// Dynamic Codex model catalogue, fetched from the installed binary (`model/list` via
// the transient app-server IPC). Feeds the composer's model picker (its Codex section)
// AND the data-driven effort gauge (each model's real `supportedReasoningEfforts`).
// Falls back to the verified static list (`CODEX_MODELS`) while loading or on error, so
// the picker is never empty. Cached process-wide (models don't change per cwd).
import { useQuery } from "@tanstack/react-query";
import { commands } from "../../ipc/client";
import type { CodexServiceTier } from "../../ipc/bindings";
import { effortLevelsForModel, type EffortLevel } from "./EffortGauge";
import { CODEX_MODELS, type ModelOption } from "./models";

export interface CodexModelsData {
  /** Picker options (dynamic when loaded, else the static fallback). */
  models: ModelOption[];
  /** model id → its supported reasoning-effort steps (for the effort gauge). */
  effortsById: Record<string, EffortLevel[]>;
  /** model id → its service tiers (`serviceTiers`), for the composer's Fast chip. Empty for
   *  a model that exposes none, and in the static fallback (which carries no tier data). */
  tiersById: Record<string, CodexServiceTier[]>;
  /** model id → its default service tier id (`defaultServiceTier`), or null. */
  defaultTierById: Record<string, string | null>;
}

const VALID_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const asEfforts = (xs: string[]): EffortLevel[] =>
  xs.filter((x): x is EffortLevel => (VALID_EFFORTS as string[]).includes(x));

/**
 * The Codex models + per-model effort steps. `enabled` gates the fetch on Codex being
 * installed (never spawns the binary otherwise). Always returns a usable catalogue: the
 * dynamic result when present, the static `CODEX_MODELS` otherwise.
 */
export function useCodexModels(enabled: boolean): CodexModelsData {
  const q = useQuery({
    queryKey: ["codexModels"],
    enabled,
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      const res = await commands.codexListModels();
      if (res.status === "error") throw new Error(res.error);
      return res.data;
    },
  });

  const list = q.data ?? [];
  if (list.length === 0) {
    // Loading / error / empty → verified static fallback. Per-model ladder via
    // effortLevelsForModel (backed by its CODEX_EFFORTS table, transcribed from this
    // very endpoint) so the fallback never lies about a model's real steps.
    const effortsById: Record<string, EffortLevel[]> = {};
    for (const m of CODEX_MODELS) effortsById[m.value] = effortLevelsForModel(m.value);
    // No tier data in the static fallback → no Fast chip until the dynamic list loads.
    return { models: CODEX_MODELS, effortsById, tiersById: {}, defaultTierById: {} };
  }

  const models: ModelOption[] = list.map((m) => ({
    label: m.displayName || m.id,
    value: m.id,
    backend: "codex",
  }));
  const effortsById: Record<string, EffortLevel[]> = {};
  const tiersById: Record<string, CodexServiceTier[]> = {};
  const defaultTierById: Record<string, string | null> = {};
  for (const m of list) {
    const steps = asEfforts(m.efforts);
    effortsById[m.id] = steps.length ? steps : effortLevelsForModel(m.id);
    tiersById[m.id] = m.serviceTiers;
    defaultTierById[m.id] = m.defaultServiceTier;
  }
  return { models, effortsById, tiersById, defaultTierById };
}
