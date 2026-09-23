// MCP permissions and plugins per scope — the pure half.
//
// Flight Deck keeps its OWN three-level cascade — Global → Repository → Conversation — and
// the narrowest level that says something wins, in BOTH directions: a repository can loosen
// a cautious global setting as well as tighten a permissive one. Claude Code can't express
// that itself (its rules resolve deny > ask > allow whatever their source, so a broad deny
// could never be undone), so the app resolves the cascade and hands each conversation ONE
// consistent rule per tool through its session layer (`apply_flag_settings`, the Rust
// `SessionOverrides`).
//
// What each level holds:
//   • tools   — `mcp__<server>__<tool>` → allow / ask / deny;
//   • servers — `mcp__<server>` → on / off (off = every tool of the server leaves Claude's
//     context; "on" at a narrower level undoes a broader "off");
//   • plugins — plugin id → on / off (Repository and Conversation; the Global plugin state is
//     Claude Code's own `enabledPlugins` in ~/.claude/settings.json).
// Within one level a tool's own setting beats its server's; across levels the narrowest wins.
//
// Claude Code's own settings FILES are the BASELINE — what "Default" means below Global.
// Whatever Flight Deck sets overrides them wherever the CLI lets it: a file `ask` is
// answered for the user when Flight Deck says Allow (the session's auto-allow), and a
// Flight Deck deny/ask always wins natively. Only a file `deny` (the tool never reaches
// the app) and the organization's policy can't be overridden — those choices are simply
// not offered.
import type { McpToolInfo, PermissionRule, SessionOverrides, ToolRuleKind } from "../../ipc/client";

/** A level of the cascade — what the panel's scope picker selects. */
export type PermissionScope = "global" | "repository" | "conversation";

/** What one level of the cascade says. */
export interface LevelPolicy {
  tools: Record<string, ToolRuleKind>;
  servers: Record<string, boolean>;
  plugins: Record<string, boolean>;
}

export const EMPTY_LEVEL: LevelPolicy = { tools: {}, servers: {}, plugins: {} };

/** The levels that apply to one context (absent = says nothing). */
export type Cascade = Partial<Record<PermissionScope, LevelPolicy>>;

/** A scope sees itself and the broader levels — never a narrower one. Narrowest first. */
const LEVELS_FROM: Record<PermissionScope, readonly PermissionScope[]> = {
  conversation: ["conversation", "repository", "global"],
  repository: ["repository", "global"],
  global: ["global"],
};

// ---- Names -------------------------------------------------------------------------------

/**
 * The CLI's server-name normalization (`hn`, binary 2.1.280): every character outside
 * `[A-Za-z0-9_-]` becomes `_`, and for a claude.ai connector (`claude.ai Gmail`) runs of
 * `_` collapse and the ends are trimmed — hence `mcp__claude_ai_Gmail__…`.
 */
export function normalizeServerName(name: string): string {
  let n = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith("claude.ai ")) n = n.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return n;
}

/** The name a permission rule uses for a server's tool: `mcp__<server>__<tool>`. */
export function mcpToolRuleName(server: string, tool: string): string {
  return tool.startsWith("mcp__") ? tool : `mcp__${normalizeServerName(server)}__${tool}`;
}

/** The rule name of a whole server (`mcp__claude_ai_Gmail`). */
export function serverRuleName(server: string): string {
  return `mcp__${normalizeServerName(server)}`;
}

/** `mcp__S__t` → `mcp__S`. */
const serverOfTool = (toolRule: string) => {
  const rest = toolRule.slice(5);
  const i = rest.indexOf("__");
  return i < 0 ? toolRule : `mcp__${rest.slice(0, i)}`;
};

// ---- The cascade --------------------------------------------------------------------------

/** What the user picks for one tool at a scope: a rule, or nothing of the scope's own. */
export type ToolChoice = "default" | ToolRuleKind;

export const TOOL_CHOICES: readonly ToolChoice[] = ["default", "allow", "ask", "deny"];

/** Where a value comes from: a Flight Deck level — or "claude", Claude Code's own files
 *  (the baseline) — and whether the tool's own setting or its server's. */
export interface From {
  level: PermissionScope | "claude";
  via: "tool" | "server";
}

/** What a tool gets at a scope, from the scope itself, a broader level, or Claude Code's
 *  files underneath (null: nothing anywhere — the conversation's permission mode decides). */
export function toolAt(
  cascade: Cascade,
  scope: PermissionScope,
  toolRule: string,
  baseline: readonly PermissionRule[] = [],
): { kind: ToolRuleKind | null; from: From | null } {
  const server = serverOfTool(toolRule);
  for (const level of LEVELS_FROM[scope]) {
    const p = cascade[level];
    if (!p) continue;
    const own = p.tools[toolRule];
    if (own) return { kind: own, from: { level, via: "tool" } };
    const s = p.servers[server];
    if (s !== undefined) return { kind: s ? null : "deny", from: { level, via: "server" } };
  }
  const file = nativeResolve(toolRule, baseline);
  return file ? { kind: file.kind, from: { level: "claude", via: "tool" } } : { kind: null, from: null };
}

/** A Claude Code `deny` covering EVERY tool of the server (the server rule, or a glob) —
 *  the one thing that keeps a server off whatever Flight Deck says. */
function fileServerDeny(server: string, baseline: readonly PermissionRule[]): boolean {
  return nativeResolve(`${serverRuleName(server)}__\u0001`, baseline)?.kind === "deny";
}

/** A server's on/off at a scope (on unless a level — or Claude Code's files — says off). */
export function serverAt(
  cascade: Cascade,
  scope: PermissionScope,
  server: string,
  baseline: readonly PermissionRule[] = [],
): { on: boolean; own: boolean | null; from: PermissionScope | "claude" | null; locked: boolean } {
  const rule = serverRuleName(server);
  const own = cascade[scope]?.servers[rule];
  const locked = fileServerDeny(server, baseline);
  if (locked) return { on: false, own: own ?? null, from: "claude", locked };
  for (const level of LEVELS_FROM[scope]) {
    const v = cascade[level]?.servers[rule];
    if (v !== undefined) return { on: v, own: own ?? null, from: level, locked };
  }
  return { on: true, own: null, from: null, locked };
}

/** What a server would be at a scope WITHOUT the scope's own say. */
export function serverInherited(cascade: Cascade, scope: PermissionScope, server: string): boolean {
  const below: Cascade = { ...cascade, [scope]: undefined };
  return serverAt(below, scope, server).on;
}

// ---- Claude Code's own files (external rules) ---------------------------------------------

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** Whether a Claude Code rule from the `kind` list reaches the MCP tool `tool`. */
export function ruleMatchesTool(rule: string, kind: ToolRuleKind, tool: string): boolean {
  if (rule === tool) return true;
  if (!rule.includes("*")) {
    // `mcp__<server>` — the whole server (a rule naming ANOTHER tool has a second `__`).
    return rule.startsWith("mcp__") && !rule.slice(5).includes("__") && tool.startsWith(`${rule}__`);
  }
  // The CLI skips an allow glob unless it sits after a literal, glob-free server prefix.
  if (kind === "allow" && !/^mcp__[^*]+?__/.test(rule)) return false;
  return globToRegExp(rule).test(tool);
}

const KIND_RANK: Record<ToolRuleKind, number> = { deny: 0, ask: 1, allow: 2 };
const SOURCE_RANK: Record<PermissionRule["source"], number> = { managed: 0, local: 1, project: 2, user: 3 };

/** How Claude Code itself resolves a set of rules: deny > ask > allow, any source. */
export function nativeResolve(tool: string, rules: readonly PermissionRule[]): PermissionRule | null {
  return (
    rules
      .filter((r) => ruleMatchesTool(r.rule, r.kind, tool))
      .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0] ?? null
  );
}

/**
 * The choices Claude Code makes impossible for a tool: its files `deny` it (the tool never
 * reaches the app — nothing to answer), or the organization's policy asks for it (never
 * answered on the user's behalf). A file `ask` is NOT among them: Flight Deck answers it
 * when its own setting is Allow.
 */
export function impossibleChoices(tool: string, baseline: readonly PermissionRule[]): Set<ToolChoice> {
  const file = nativeResolve(tool, baseline);
  if (file?.kind === "deny") return new Set(["allow", "ask"]);
  const managedAsk = nativeResolve(tool, baseline.filter((r) => r.source === "managed"));
  return managedAsk?.kind === "ask" ? new Set(["allow"]) : new Set();
}

// ---- One tool row -------------------------------------------------------------------------

export interface ToolRowState {
  /** The scope's own setting for the tool, or "default" (follow what's underneath). */
  choice: ToolChoice;
  /** What the tool gets at this scope (own, else inherited — Claude Code's files last);
   *  null = nothing anywhere, the permission mode decides. */
  shown: ToolRuleKind | null;
  /** Where `shown` comes from, when not the scope's own tool setting. */
  from: From | null;
  /** Choices Claude Code doesn't let anything override — not offered. */
  impossible: Set<ToolChoice>;
}

export function toolRowState(
  cascade: Cascade,
  scope: PermissionScope,
  toolRule: string,
  baseline: readonly PermissionRule[],
): ToolRowState {
  const own = cascade[scope]?.tools[toolRule];
  const impossible = impossibleChoices(toolRule, baseline);
  const at = toolAt(cascade, scope, toolRule, baseline);
  // A file deny wins whatever is set — show what really applies.
  const shown = impossible.has("allow") && impossible.has("ask") ? "deny" : at.kind;
  return {
    choice: own && !impossible.has(own) ? own : "default",
    shown,
    from: own && !impossible.has(own) ? null : at.from,
    impossible,
  };
}

// ---- Plugins ------------------------------------------------------------------------------

/** Claude Code's own say on a plugin: `enabledPlugins[id]` in one of its settings files. */
export interface PluginFileSay {
  source: PermissionRule["source"];
  enabled: boolean;
}

export interface PluginScopeState {
  /** On at this scope (its own say, else what it inherits). */
  enabled: boolean;
  /** The scope has a say of its own. */
  own: boolean;
  /** What it would be without the scope's own say. */
  inherited: boolean;
  /** Claude Code's organization policy decides — nothing here can change it. */
  lockedByPolicy: boolean;
}

/**
 * A plugin seen from a scope. Global = Claude Code's own files (user, then the project's
 * shared/local ones do NOT count — they're a repository's, not global); Repository and
 * Conversation = Flight Deck's cascade over that. `fallback` = the configuration scan's
 * answer when no file says anything.
 */
export function pluginAt(
  cascade: Cascade,
  scope: PermissionScope,
  pluginId: string,
  files: readonly PluginFileSay[],
  fallback: boolean,
): PluginScopeState {
  const file = (s: PluginFileSay["source"]) => files.find((f) => f.source === s)?.enabled;
  const globalValue = file("user") ?? fallback;
  const valueFrom = (levels: readonly PermissionScope[]) => {
    for (const level of levels) {
      if (level === "global") return globalValue;
      const v = cascade[level]?.plugins[pluginId];
      if (v !== undefined) return v;
    }
    return globalValue;
  };
  const levels = LEVELS_FROM[scope];
  const own = scope === "global" ? file("user") !== undefined : cascade[scope]?.plugins[pluginId] !== undefined;
  return {
    enabled: valueFrom(levels),
    own,
    inherited: scope === "global" ? fallback : valueFrom(levels.slice(1)),
    lockedByPolicy: file("managed") !== undefined,
  };
}

/** What to write when the user flips a plugin at a scope: nothing of its own (null) when
 *  that's what it would follow anyway; the global file always holds an explicit value. */
export function pluginWrite(state: PluginScopeState, enabled: boolean, scope: PermissionScope): boolean | null {
  return scope !== "global" && enabled === state.inherited ? null : enabled;
}

// ---- What a conversation's session receives -------------------------------------------------

/**
 * The one consistent rule set a conversation runs under: for every tool any level talks
 * about, its narrowest setting. A server turned off becomes one `deny` on the server — or,
 * when a narrower level re-allows some of its tools, a `deny` on each of its OTHER known
 * tools (Claude's deny > allow would otherwise swallow the exception). `toolCache` = the
 * tools each server was last seen with.
 */
export function sessionOverridesFrom(cascade: Cascade, toolCache: Readonly<Record<string, readonly string[]>>): SessionOverrides {
  const out: SessionOverrides = { allow: [], ask: [], deny: [], enabled_plugins: {} };
  const servers = new Set<string>();
  const toolsOf = new Map<string, Set<string>>();
  for (const level of ["global", "repository", "conversation"] as const) {
    const p = cascade[level];
    if (!p) continue;
    for (const s of Object.keys(p.servers)) servers.add(s);
    for (const t of Object.keys(p.tools)) {
      const s = serverOfTool(t);
      servers.add(s);
      if (!toolsOf.has(s)) toolsOf.set(s, new Set());
      toolsOf.get(s)!.add(t);
    }
  }
  const push = (tool: string, kind: ToolRuleKind | null) => {
    if (kind) out[kind].push(tool);
  };
  for (const server of [...servers].sort()) {
    const named = toolsOf.get(server) ?? new Set<string>();
    const on = (() => {
      for (const level of LEVELS_FROM.conversation) {
        const v = cascade[level]?.servers[server];
        if (v !== undefined) return v;
      }
      return true;
    })();
    if (on) {
      for (const t of [...named].sort()) push(t, toolAt(cascade, "conversation", t).kind);
      continue;
    }
    const exceptions = [...named].filter((t) => {
      const r = toolAt(cascade, "conversation", t);
      return r.from?.via === "tool" && r.kind !== "deny";
    });
    if (!exceptions.length) {
      out.deny.push(server);
      continue;
    }
    const known = new Set([...(toolCache[server] ?? []).map((t) => `${server}__${t}`), ...named]);
    for (const t of [...known].sort()) push(t, toolAt(cascade, "conversation", t).kind ?? "deny");
  }
  const plugins: Record<string, boolean> = {};
  for (const level of ["repository", "conversation"] as const) Object.assign(plugins, cascade[level]?.plugins ?? {});
  out.enabled_plugins = Object.fromEntries(Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b)));
  return out;
}

export function isEmptyOverrides(o: SessionOverrides): boolean {
  return !o.allow.length && !o.ask.length && !o.deny.length && !Object.keys(o.enabled_plugins ?? {}).length;
}

// ---- Read vs write --------------------------------------------------------------------------

/** Whether a tool reads or acts, and how we know. */
export interface ToolNature {
  nature: "read" | "write";
  /** `annotation`: the server said so. `name`: guessed from the tool's name. */
  from: "annotation" | "name";
}

const WRITE_WORDS = new Set([
  "send", "create", "update", "delete", "remove", "trash", "archive", "write", "post", "set",
  "add", "move", "share", "label", "unlabel", "mark", "unmark", "reply", "forward", "respond",
  "schedule", "apply", "upload", "copy", "edit", "modify", "deploy", "redeploy", "restart",
  "accept", "cancel", "stop", "run", "execute", "invite", "publish", "merge", "close",
  "untrash", "approve", "reject", "rename", "insert", "replace", "clear", "reset", "import",
]);
const READ_WORDS = new Set([
  "get", "list", "search", "read", "fetch", "find", "query", "view", "describe", "count",
  "check", "lookup", "show", "download", "whoami", "status", "logs", "metrics", "diagnosis",
]);

/**
 * Read or write. The server's own annotations win (`readOnly`, `destructive`); without
 * them the name decides — any action word makes it a write, a read word alone a read,
 * and a name with neither is a write: the guess errs toward asking, never toward
 * silently allowing.
 */
export function toolNature(t: Pick<McpToolInfo, "name" | "read_only" | "destructive">): ToolNature {
  if (t.read_only === true) return { nature: "read", from: "annotation" };
  if (t.read_only === false || t.destructive === true) return { nature: "write", from: "annotation" };
  const words = t.name
    .split(/[_\-.\s]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.some((w) => WRITE_WORDS.has(w))) return { nature: "write", from: "name" };
  if (words.some((w) => READ_WORDS.has(w))) return { nature: "read", from: "name" };
  return { nature: "write", from: "name" };
}

// ---- Batch actions (they write the scope's OWN tool settings) --------------------------------

export interface ToolChange {
  tool: string;
  kind: ToolRuleKind | null;
}

type ToolLike = Pick<McpToolInfo, "name" | "read_only" | "destructive">;

/** Set every tool of a server to what `pick` wants for it — only where the choice changes. */
function bulk(cascade: Cascade, scope: PermissionScope, server: string, tools: readonly ToolLike[], pick: (t: ToolLike) => ToolRuleKind): ToolChange[] {
  return tools
    .map((t) => ({ tool: mcpToolRuleName(server, t.name), kind: pick(t) }))
    .filter((c) => cascade[scope]?.tools[c.tool] !== c.kind);
}

/** The "read-only" preset: reads allowed, everything else asks first. */
export function readOnlyPreset(cascade: Cascade, scope: PermissionScope, server: string, tools: readonly ToolLike[]): ToolChange[] {
  return bulk(cascade, scope, server, tools, (t) => (toolNature(t).nature === "read" ? "allow" : "ask"));
}

/** Every tool of the server to the same rule (Allow all / Ask for all / Block all). */
export function setAll(cascade: Cascade, scope: PermissionScope, server: string, tools: readonly ToolLike[], kind: ToolRuleKind): ToolChange[] {
  return bulk(cascade, scope, server, tools, () => kind);
}

/** Remove the scope's own settings for this server's tools. */
export function resetServer(cascade: Cascade, scope: PermissionScope, server: string, tools: readonly Pick<McpToolInfo, "name">[]): ToolChange[] {
  return tools
    .map((t) => mcpToolRuleName(server, t.name))
    .filter((tool) => cascade[scope]?.tools[tool] !== undefined)
    .map((tool) => ({ tool, kind: null }));
}

/** How many of a server's tools are blocked / ask / allowed at a scope, for its row. */
export function serverSummary(
  cascade: Cascade,
  scope: PermissionScope,
  server: string,
  tools: readonly Pick<McpToolInfo, "name">[],
  baseline: readonly PermissionRule[] = [],
): { deny: number; ask: number; allow: number } {
  const out = { deny: 0, ask: 0, allow: 0 };
  for (const t of tools) {
    const k = toolRowState(cascade, scope, mcpToolRuleName(server, t.name), baseline).shown;
    if (k) out[k]++;
  }
  return out;
}

// ---- Words ------------------------------------------------------------------------------------

export const LEVEL_LABEL: Record<PermissionScope, string> = {
  global: "Global",
  repository: "this repository",
  conversation: "this conversation",
};

/** "Global" / "this repository (the whole server)" / "Claude Code" — where a value comes from. */
export function describeFrom(f: From): string {
  const where = f.level === "claude" ? "Claude Code" : f.level === "global" ? "Global" : LEVEL_LABEL[f.level];
  return f.via === "server" ? `${where} (the whole server)` : where;
}
