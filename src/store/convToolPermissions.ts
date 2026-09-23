// A conversation's OWN extension settings — what its panel (⌘E) changes with the
// "This conversation" scope: MCP rules (per tool, or a whole server off) and plugins on/off.
// They live in the session's flag settings layer (`apply_flag_settings`), which dies with
// the process, so the app is their only memory: persisted here (localStorage, like the
// other per-conversation UI state), handed to every spawn (`SpawnFlags.sessionOverrides` →
// re-applied right after `initialize`), and pushed to the running session on change.
import { create } from "zustand";
import { commands } from "../ipc/client";
import type { SessionOverrides, ToolRuleKind } from "../ipc/client";
import type { PluginSay, ToolChange, ToolRule } from "../features/extensions/mcpToolPermissions";

const STORAGE_KEY = "tosse:convToolPerms";

export interface ConvOverrides {
  /** MCP rule name (a tool, or a whole server) → kind. */
  rules: Record<string, ToolRuleKind>;
  /** Plugin id → on/off for this conversation. */
  plugins: Record<string, boolean>;
}

type ByConv = Record<string, ConvOverrides>;

const EMPTY: ConvOverrides = { rules: {}, plugins: {} };

/** Accepts the first shape this store had (`{convId: {rule: kind}}`) as rules. */
function load(): ByConv {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: ByConv = {};
    for (const [conv, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const o = v as Partial<ConvOverrides>;
      out[conv] =
        "rules" in o || "plugins" in o
          ? { rules: o.rules ?? {}, plugins: o.plugins ?? {} }
          : { rules: v as Record<string, ToolRuleKind>, plugins: {} };
    }
    return out;
  } catch {
    return {};
  }
}

function save(byConv: ByConv) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byConv));
  } catch {
    // Storage full / disabled: the settings still apply to the running session.
  }
}

const isEmpty = (o: ConvOverrides) => !Object.keys(o.rules).length && !Object.keys(o.plugins).length;

interface State {
  byConv: ByConv;
  /** Replace one conversation's overrides (no IPC — see applyConvOverrides). */
  commit: (convId: string, next: ConvOverrides) => void;
  clearConversation: (convId: string) => void;
  clearAll: () => void;
}

export const useConvToolPermissions = create<State>((set, get) => ({
  byConv: load(),
  commit: (convId, next) => {
    const all = { ...get().byConv };
    if (isEmpty(next)) delete all[convId];
    else all[convId] = next;
    set({ byConv: all });
    save(all);
  },
  clearConversation: (convId) => {
    if (!(convId in get().byConv)) return;
    const all = { ...get().byConv };
    delete all[convId];
    set({ byConv: all });
    save(all);
  },
  clearAll: () => {
    set({ byConv: {} });
    save({});
  },
}));

export interface PluginChange {
  id: string;
  enabled: boolean | null;
}

function withChanges(o: ConvOverrides, rules: readonly ToolChange[], plugins: readonly PluginChange[]): ConvOverrides {
  const next: ConvOverrides = { rules: { ...o.rules }, plugins: { ...o.plugins } };
  for (const c of rules) {
    if (c.kind) next.rules[c.tool] = c.kind;
    else delete next.rules[c.tool];
  }
  for (const p of plugins) {
    if (p.enabled === null) delete next.plugins[p.id];
    else next.plugins[p.id] = p.enabled;
  }
  return next;
}

/** The session-layer payload (sorted, so it is stable). */
function toSessionOverrides(o: ConvOverrides): SessionOverrides {
  const out: SessionOverrides = { allow: [], ask: [], deny: [], enabled_plugins: {} };
  for (const [rule, kind] of Object.entries(o.rules).sort(([a], [b]) => a.localeCompare(b))) out[kind].push(rule);
  for (const [id, on] of Object.entries(o.plugins).sort(([a], [b]) => a.localeCompare(b))) out.enabled_plugins![id] = on;
  return out;
}

/** What a spawn of this conversation must re-apply; `null` when it has nothing of its own. */
export function sessionOverridesFor(convId: string): SessionOverrides | null {
  const o = useConvToolPermissions.getState().byConv[convId];
  return o && !isEmpty(o) ? toSessionOverrides(o) : null;
}

/** The conversation's rules as resolution inputs (source "conversation"). */
export function convToolRules(byConv: ByConv, convId: string): ToolRule[] {
  return Object.entries(byConv[convId]?.rules ?? {}).map(([rule, kind]) => ({
    rule,
    kind,
    source: "conversation" as const,
    path: "",
  }));
}

/** The conversation's say on one plugin, if any. */
export function convPluginSay(byConv: ByConv, convId: string, pluginId: string): PluginSay[] {
  const v = byConv[convId]?.plugins[pluginId];
  return v === undefined ? [] : [{ source: "conversation", enabled: v }];
}

/**
 * Change a conversation's own settings. With a RUNNING session the whole new set is pushed
 * first (a plugin change with a reload) and only committed once the CLI accepted it — so
 * the panel never shows a setting the live conversation isn't actually under. Without one,
 * it is committed and applied at the next spawn.
 */
export async function applyConvOverrides(
  convId: string,
  handle: string | null,
  rules: readonly ToolChange[],
  plugins: readonly PluginChange[] = [],
): Promise<void> {
  if (!rules.length && !plugins.length) return;
  const next = withChanges(useConvToolPermissions.getState().byConv[convId] ?? EMPTY, rules, plugins);
  if (handle) {
    const res = await commands.applySessionOverrides(handle, toSessionOverrides(next), plugins.length > 0);
    if (res.status === "error") throw new Error(`The running conversation refused the change: ${res.error}`);
  }
  useConvToolPermissions.getState().commit(convId, next);
}

export function clearConvToolPermissions(convId: string): void {
  useConvToolPermissions.getState().clearConversation(convId);
}

export function clearAllConvToolPermissions(): void {
  useConvToolPermissions.getState().clearAll();
}
