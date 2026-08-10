// Dynamic Claude model catalogue, read from a RUNNING session via the `list_models`
// control request. Mirror of codexModels.ts, with one structural difference: Codex can
// be asked through a transient app-server, whereas Claude's catalogue only exists
// inside a live session — so this hook needs a live handle, and remembers the last
// answer process-wide to keep the picker accurate for conversations that aren't spawned.
//
// Why bother, when a static list "works": the binary applies the provider, the settings
// cascade and the org enforcement policy, so a hard-coded table both drifts on every
// model launch and can offer a model the account is not allowed to run. Falls back to
// the static `CLAUDE_MODELS` while nothing has answered yet, so the picker is never empty.
import { useQuery } from "@tanstack/react-query";
import { commands } from "../../ipc/client";
import { useConversationsStore } from "../../store/conversationsStore";
import { CLAUDE_MODELS, type ModelOption } from "./models";

export interface ClaudeModelsData {
  /** Picker options — live when known, else the static fallback. */
  models: ModelOption[];
  /** model alias → the effort steps that model really accepts (empty when it takes none). */
  effortsById: Record<string, string[]>;
  /** model alias → the concrete model it resolves to (e.g. `claude-opus-5[1m]`). */
  resolvedById: Record<string, string>;
}

/** Last catalogue any session reported, kept for the whole process. The catalogue is
 *  account-wide, so once ANY session has answered, every conversation can show the real
 *  list — including ones with no live process (the app spawns lazily). Never reset to a
 *  worse value: an empty or failed read leaves the previous answer standing. */
let lastKnownGood: ClaudeModelsData | null = null;

/** Exposed for tests only. */
export function __resetClaudeModelsCache() {
  lastKnownGood = null;
}

const STATIC: ClaudeModelsData = { models: CLAUDE_MODELS, effortsById: {}, resolvedById: {} };

/**
 * The Claude catalogue for `convId`'s picker. Queries the conversation's live session
 * when it has one; otherwise serves the last known catalogue, then the static list.
 */
export function useClaudeModels(convId: string): ClaudeModelsData {
  const handle = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.handle ?? null,
  );

  const q = useQuery({
    queryKey: ["claudeModels", handle],
    enabled: !!handle,
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      const res = await commands.listSessionModels(handle!);
      if (res.status === "error") throw new Error(res.error);
      return res.data;
    },
  });

  const list = q.data ?? [];
  if (list.length === 0) return lastKnownGood ?? STATIC;

  const models: ModelOption[] = list.map((m) => ({
    label: m.display_name || m.value,
    value: m.value,
    backend: "claude",
  }));
  const effortsById: Record<string, string[]> = {};
  const resolvedById: Record<string, string> = {};
  for (const m of list) {
    effortsById[m.value] = m.supports_effort ? m.supported_effort_levels : [];
    if (m.resolved_model) resolvedById[m.value] = m.resolved_model;
  }
  lastKnownGood = { models, effortsById, resolvedById };
  return lastKnownGood;
}
