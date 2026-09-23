// Flight Deck's own MCP permission / plugin cascade: a Global level, one level per
// repository (the app's repository record — its worktrees included) and one per
// conversation. Persisted in localStorage like the other per-conversation UI state.
//
// A conversation runs under the RESOLVED cascade (see mcpToolPermissions.ts
// `sessionOverridesFrom`), delivered through its session layer: handed to every spawn
// (`SpawnFlags.sessionOverrides`, re-applied right after `initialize`) and pushed to the
// running sessions a change reaches — every live Claude conversation for a Global change,
// the repository's for a Repository one, the conversation itself for its own.
import { create } from "zustand";
import { commands } from "../ipc/client";
import type { SessionOverrides, ToolRuleKind } from "../ipc/client";
import {
  EMPTY_LEVEL,
  isEmptyOverrides,
  serverRuleName,
  sessionOverridesFrom,
  type Cascade,
  type LevelPolicy,
  type PermissionScope,
  type ToolChange,
} from "../features/extensions/mcpToolPermissions";
import { useConversationsStore } from "./conversationsStore";

const STORAGE_KEY = "tosse:mcpPolicy";
/** The first per-conversation store of this feature (rules + plugins), migrated once. */
const LEGACY_CONV_KEY = "tosse:convToolPerms";

interface PolicyData {
  global: LevelPolicy;
  repos: Record<string, LevelPolicy>;
  convs: Record<string, LevelPolicy>;
  /** Server rule name → the tool names it was last seen with (for "server off, except…"). */
  toolCache: Record<string, string[]>;
}

const EMPTY: PolicyData = { global: EMPTY_LEVEL, repos: {}, convs: {}, toolCache: {} };

const level = (v: unknown): LevelPolicy => {
  const o = (v && typeof v === "object" ? v : {}) as Partial<LevelPolicy>;
  return { tools: { ...(o.tools ?? {}) }, servers: { ...(o.servers ?? {}) }, plugins: { ...(o.plugins ?? {}) } };
};

function migrateLegacy(): Record<string, LevelPolicy> {
  try {
    const raw = localStorage.getItem(LEGACY_CONV_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { rules?: Record<string, ToolRuleKind>; plugins?: Record<string, boolean> }>;
    const out: Record<string, LevelPolicy> = {};
    for (const [conv, o] of Object.entries(parsed ?? {})) {
      const lp = level({ plugins: o?.plugins });
      for (const [rule, kind] of Object.entries(o?.rules ?? {})) {
        // A bare `mcp__<server>` deny was how the first version turned a server off.
        if (rule.slice(5).includes("__")) lp.tools[rule] = kind;
        else if (kind === "deny") lp.servers[rule] = false;
      }
      out[conv] = lp;
    }
    localStorage.removeItem(LEGACY_CONV_KEY);
    return out;
  } catch {
    return {};
  }
}

function load(): PolicyData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<PolicyData>) : {};
    const convs = Object.fromEntries(Object.entries(p.convs ?? {}).map(([k, v]) => [k, level(v)]));
    return {
      global: level(p.global),
      repos: Object.fromEntries(Object.entries(p.repos ?? {}).map(([k, v]) => [k, level(v)])),
      convs: { ...migrateLegacy(), ...convs },
      toolCache: p.toolCache ?? {},
    };
  } catch {
    return EMPTY;
  }
}

function save(d: PolicyData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    // Storage full / disabled: the settings still apply to the running sessions.
  }
}

const isEmptyLevel = (p: LevelPolicy) =>
  !Object.keys(p.tools).length && !Object.keys(p.servers).length && !Object.keys(p.plugins).length;

export const useMcpPolicy = create<PolicyData>(() => load());

function persist(next: PolicyData) {
  useMcpPolicy.setState(next, true);
  save(next);
}

/** Where a change lands: the Global level, a repository's, or a conversation's. */
export interface PolicyTarget {
  scope: PermissionScope;
  /** Repository id (Repository scope) or conversation id (Conversation scope). */
  key: string | null;
}

export interface PolicyChanges {
  tools?: readonly ToolChange[];
  /** Server rule on/off; null drops the level's say. */
  servers?: readonly { server: string; on: boolean | null }[];
  /** Plugin on/off; null drops the level's say. */
  plugins?: readonly { id: string; enabled: boolean | null }[];
}

function withChanges(p: LevelPolicy, c: PolicyChanges): LevelPolicy {
  const next = level(p);
  for (const t of c.tools ?? []) {
    if (t.kind) next.tools[t.tool] = t.kind;
    else delete next.tools[t.tool];
  }
  for (const s of c.servers ?? []) {
    const rule = serverRuleName(s.server);
    if (s.on === null) delete next.servers[rule];
    else next.servers[rule] = s.on;
  }
  for (const pl of c.plugins ?? []) {
    if (pl.enabled === null) delete next.plugins[pl.id];
    else next.plugins[pl.id] = pl.enabled;
  }
  return next;
}

function levelOf(d: PolicyData, t: PolicyTarget): LevelPolicy {
  if (t.scope === "global") return d.global;
  const map = t.scope === "repository" ? d.repos : d.convs;
  return (t.key && map[t.key]) || EMPTY_LEVEL;
}

function withLevel(d: PolicyData, t: PolicyTarget, p: LevelPolicy): PolicyData {
  if (t.scope === "global") return { ...d, global: p };
  const field = t.scope === "repository" ? "repos" : "convs";
  const map = { ...d[field] };
  if (!t.key) return d;
  if (isEmptyLevel(p)) delete map[t.key];
  else map[t.key] = p;
  return { ...d, [field]: map };
}

/** The cascade a conversation (or a repository, or nothing) sees. */
export function cascadeOf(d: PolicyData, repoId: string | null, convId: string | null): Cascade {
  return {
    global: d.global,
    repository: repoId ? d.repos[repoId] : undefined,
    conversation: convId ? d.convs[convId] : undefined,
  };
}

/** The session layer a conversation must run under; `null` when nothing applies. */
export function sessionOverridesForConv(convId: string, repoId: string | null): SessionOverrides | null {
  const d = useMcpPolicy.getState();
  const o = sessionOverridesFrom(cascadeOf(d, repoId, convId), d.toolCache);
  return isEmptyOverrides(o) ? null : o;
}

/**
 * Change one level, then push the result to every running Claude conversation it reaches.
 * A conversation's own change is only kept once its running session accepted it (the panel
 * never shows a setting the live conversation isn't under). A Global / Repository change is
 * kept either way — it applies at the next spawn — and every session that refused it is
 * named in the error.
 */
export async function applyPolicyChange(target: PolicyTarget, changes: PolicyChanges): Promise<void> {
  const before = useMcpPolicy.getState();
  const after = withLevel(before, target, withChanges(levelOf(before, target), changes));
  const convs = useConversationsStore
    .getState()
    .conversations.filter(
      (c) =>
        c.kind === "claude" &&
        c.handle &&
        (target.scope === "global" ||
          (target.scope === "repository" && c.repoId === target.key) ||
          (target.scope === "conversation" && c.id === target.key)),
    );
  const reloadPlugins = (changes.plugins?.length ?? 0) > 0;
  if (target.scope === "conversation") {
    const c = convs[0];
    if (c) {
      const res = await commands.applySessionOverrides(
        c.handle!,
        sessionOverridesFrom(cascadeOf(after, c.repoId, c.id), after.toolCache),
        reloadPlugins,
      );
      if (res.status === "error") throw new Error(`The running conversation refused the change: ${res.error}`);
    }
    persist(after);
    return;
  }
  persist(after);
  const refused: string[] = [];
  await Promise.all(
    convs.map(async (c) => {
      const res = await commands.applySessionOverrides(
        c.handle!,
        sessionOverridesFrom(cascadeOf(after, c.repoId, c.id), after.toolCache),
        reloadPlugins,
      );
      if (res.status === "error") refused.push(`${c.name}: ${res.error}`);
    }),
  );
  if (refused.length) {
    throw new Error(`Saved, but ${refused.length} running conversation(s) refused it (they'll get it on restart): ${refused.join("; ")}`);
  }
}

/** Remember the tools a server was seen with — how "server off, except these" is emitted. */
export function noteServerTools(server: string, tools: readonly string[]): void {
  if (!tools.length) return;
  const d = useMcpPolicy.getState();
  const rule = serverRuleName(server);
  const prev = d.toolCache[rule];
  if (prev && prev.length === tools.length && prev.every((t, i) => t === tools[i])) return;
  persist({ ...d, toolCache: { ...d.toolCache, [rule]: [...tools] } });
}

export function clearConvPolicy(convId: string): void {
  const d = useMcpPolicy.getState();
  if (!(convId in d.convs)) return;
  const convs = { ...d.convs };
  delete convs[convId];
  persist({ ...d, convs });
}

export function clearAllPolicy(): void {
  persist(EMPTY);
}
