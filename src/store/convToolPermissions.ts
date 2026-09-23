// A conversation's OWN per-tool permission rules — the ones set from its extensions panel
// (⌘E), which reach that conversation alone. They live in the session's flag settings
// layer (`apply_flag_settings`), which dies with the process, so the app is their only
// memory: persisted here (localStorage, like the other per-conversation UI state), handed
// to every spawn (`SpawnFlags.sessionPermissions` → re-applied after `initialize`), and
// pushed to the running session when they change.
import { create } from "zustand";
import { commands } from "../ipc/client";
import type { SessionToolRules, ToolRuleKind } from "../ipc/client";
import type { ToolChange, ToolRule } from "../features/extensions/mcpToolPermissions";

const STORAGE_KEY = "tosse:convToolPerms";

/** tool rule name → kind, per conversation id. */
type ByConv = Record<string, Record<string, ToolRuleKind>>;

function load(): ByConv {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as ByConv) : {};
  } catch {
    return {};
  }
}

function save(byConv: ByConv) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byConv));
  } catch {
    // Storage full / disabled: the rules still apply to the running session.
  }
}

interface State {
  byConv: ByConv;
  /** Commit changes for one conversation (no IPC — see applyConvToolPermissions). */
  commit: (convId: string, changes: readonly ToolChange[]) => void;
  clearConversation: (convId: string) => void;
  clearAll: () => void;
}

export const useConvToolPermissions = create<State>((set, get) => ({
  byConv: load(),
  commit: (convId, changes) => {
    const next = { ...get().byConv, [convId]: applyChanges(get().byConv[convId] ?? {}, changes) };
    if (Object.keys(next[convId]).length === 0) delete next[convId];
    set({ byConv: next });
    save(next);
  },
  clearConversation: (convId) => {
    if (!(convId in get().byConv)) return;
    const next = { ...get().byConv };
    delete next[convId];
    set({ byConv: next });
    save(next);
  },
  clearAll: () => {
    set({ byConv: {} });
    save({});
  },
}));

function applyChanges(rules: Record<string, ToolRuleKind>, changes: readonly ToolChange[]) {
  const out = { ...rules };
  for (const c of changes) {
    if (c.kind) out[c.tool] = c.kind;
    else delete out[c.tool];
  }
  return out;
}

/** The session-layer payload for a set of rules (sorted, so it is stable). */
function toSessionRules(rules: Record<string, ToolRuleKind>): SessionToolRules {
  const out: SessionToolRules = { allow: [], ask: [], deny: [] };
  for (const [tool, kind] of Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))) out[kind].push(tool);
  return out;
}

/** What a spawn of this conversation must re-apply; `null` when it has no rule of its own. */
export function sessionRulesFor(convId: string): SessionToolRules | null {
  const rules = useConvToolPermissions.getState().byConv[convId];
  return rules && Object.keys(rules).length ? toSessionRules(rules) : null;
}

/** The conversation's rules as resolution inputs (source "conversation"). */
export function convToolRules(byConv: ByConv, convId: string): ToolRule[] {
  return Object.entries(byConv[convId] ?? {}).map(([rule, kind]) => ({
    rule,
    kind,
    source: "conversation" as const,
    path: "",
  }));
}

/**
 * Change a conversation's own rules. With a RUNNING session, the new set is pushed first
 * and only committed once the CLI accepted it — so the panel never shows a rule the live
 * conversation isn't actually under. Without one, it is committed and applied at the next
 * spawn.
 */
export async function applyConvToolPermissions(
  convId: string,
  handle: string | null,
  changes: readonly ToolChange[],
): Promise<void> {
  if (!changes.length) return;
  const current = useConvToolPermissions.getState().byConv[convId] ?? {};
  if (handle) {
    const res = await commands.applySessionPermissions(handle, toSessionRules(applyChanges(current, changes)));
    if (res.status === "error") throw new Error(`The running conversation refused the change: ${res.error}`);
  }
  useConvToolPermissions.getState().commit(convId, changes);
}

export function clearConvToolPermissions(convId: string): void {
  useConvToolPermissions.getState().clearConversation(convId);
}

export function clearAllConvToolPermissions(): void {
  useConvToolPermissions.getState().clearAll();
}
