// Per-tool permission for MCP tools — the pure half. Resolves Claude Code's own
// `permissions.allow` / `ask` / `deny` rules into what the UI needs for one tool: the
// panel's own choice, what REALLY applies, and which choices would actually hold.
//
// Rules come from two kinds of place:
//   • the settings files (managed, local, project, user) — read by the Rust
//     `extensions::permissions` module; the GLOBAL panel (Settings → Extensions) manages
//     the user file's exact-name rules;
//   • one conversation's session layer (`apply_flag_settings`, the Rust `SessionToolRules`)
//     — the CONVERSATION panel (⌘E) manages those, and they reach that conversation alone.
//
// The CLI's semantics, mirrored here (docs + binary 2.1.280):
//   • deny > ask > allow — whatever the rule's specificity or where it sits, so a project
//     `deny` beats a user `allow`, a global `ask` beats a conversation `allow`: a
//     conversation can tighten the global rules, never loosen them.
//   • `mcp__<server>` matches every tool of that server; deny/ask accept a glob anywhere in
//     the tool name (`*`, `mcp__*`), allow only after a literal `mcp__<server>__` prefix.
//   • A choice another rule would override is never offered as if it would take effect.
import type { McpToolInfo, PermissionRule, ToolRuleKind } from "../../ipc/client";

/** Where a rule sits: one of the settings files, or the conversation's own session layer. */
export type ToolRuleSource = PermissionRule["source"] | "conversation";

/** A permission rule from any source — a file rule, or one of the conversation's own. */
export interface ToolRule {
  rule: string;
  kind: ToolRuleKind;
  source: ToolRuleSource;
  path: string;
}

/** Which rules a panel manages: one conversation's session layer, this repository's local
 *  file (`.claude/settings.local.json`, this machine only), or the user's settings file
 *  (every conversation). The other sources' rules still apply and are shown. */
export type PermissionScope = "conversation" | "repository" | "global";

const OWN_SOURCE: Record<PermissionScope, ToolRuleSource> = {
  conversation: "conversation",
  repository: "local",
  global: "user",
};

/** What the user picks for one tool: one of the three rule lists, or no rule at all. */
export type ToolChoice = "default" | ToolRuleKind;

export const TOOL_CHOICES: readonly ToolChoice[] = ["default", "allow", "ask", "deny"];

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

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** Whether a rule from the `kind` list reaches the MCP tool `tool` (a full rule name). */
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

/** What applies to a tool, and the rule responsible (null: no rule — the mode decides). */
export interface Resolution {
  kind: ToolRuleKind | null;
  rule: ToolRule | null;
}

const KIND_RANK: Record<ToolRuleKind, number> = { deny: 0, ask: 1, allow: 2 };
const SOURCE_RANK: Record<ToolRuleSource, number> = { managed: 0, conversation: 1, local: 2, project: 3, user: 4 };

/** deny > ask > allow; among equals, the most authoritative source is the one named. */
export function resolvePermission(tool: string, rules: readonly ToolRule[]): Resolution {
  const best = rules
    .filter((r) => ruleMatchesTool(r.rule, r.kind, tool))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0];
  return best ? { kind: best.kind, rule: best } : { kind: null, rule: null };
}

/** A rule the panel manages for this tool: its exact name, in the scope's own source. */
const isOwn = (r: ToolRule, tool: string, scope: PermissionScope) =>
  r.source === OWN_SOURCE[scope] && r.rule === tool;

export interface ChoiceOption {
  /** Picking it would really be what applies. */
  holds: boolean;
  /** When it wouldn't: the rule that wins instead. */
  blockedBy: ToolRule | null;
}

export interface ToolPermissionState {
  /** The full rule name (`mcp__claude_ai_Gmail__send_message`). */
  tool: string;
  /** The scope's own rule for the tool, or "default" when it has none. */
  choice: ToolChoice;
  /** What really applies, every source considered. */
  effective: Resolution;
  /** What would apply with no rule of the scope's own — what "Default" means here. */
  inherited: Resolution;
  options: Record<ToolChoice, ChoiceOption>;
}

export function toolPermissionState(
  tool: string,
  rules: readonly ToolRule[],
  scope: PermissionScope = "global",
): ToolPermissionState {
  const own = rules.filter((r) => isOwn(r, tool, scope));
  const others = rules.filter((r) => !isOwn(r, tool, scope));
  const choice: ToolChoice = own.length
    ? [...own].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0].kind
    : "default";
  const option = (kind: ToolRuleKind): ChoiceOption => {
    const mine: ToolRule = { rule: tool, kind, source: OWN_SOURCE[scope], path: "" };
    const r = resolvePermission(tool, [...others, mine]);
    return r.kind === kind ? { holds: true, blockedBy: null } : { holds: false, blockedBy: r.rule };
  };
  return {
    tool,
    choice,
    effective: resolvePermission(tool, rules),
    inherited: resolvePermission(tool, others),
    // "Default" always holds: it only removes the scope's own rule.
    options: { default: { holds: true, blockedBy: null }, allow: option("allow"), ask: option("ask"), deny: option("deny") },
  };
}

// ---- Read vs write --------------------------------------------------------------------

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

// ---- Batch actions ----------------------------------------------------------------------

export interface ToolChange {
  tool: string;
  kind: ToolRuleKind | null;
}

type ToolLike = Pick<McpToolInfo, "name" | "read_only" | "destructive">;

/**
 * Set every tool of a server to what `pick` wants for it. Only choices that would hold are
 * written (one a stricter rule elsewhere overrides is skipped, and counted, rather than
 * written as a rule that does nothing), and only where the choice changes.
 */
function bulk(
  server: string,
  tools: readonly ToolLike[],
  rules: readonly ToolRule[],
  scope: PermissionScope,
  pick: (t: ToolLike) => ToolRuleKind,
): { changes: ToolChange[]; skipped: number } {
  const changes: ToolChange[] = [];
  let skipped = 0;
  for (const t of tools) {
    const tool = mcpToolRuleName(server, t.name);
    const want = pick(t);
    const s = toolPermissionState(tool, rules, scope);
    if (!s.options[want].holds) skipped++;
    else if (s.choice !== want) changes.push({ tool, kind: want });
  }
  return { changes, skipped };
}

/** The "read-only" preset: reads allowed, everything else asks first. */
export function readOnlyPreset(
  server: string,
  tools: readonly ToolLike[],
  rules: readonly ToolRule[],
  scope: PermissionScope = "global",
): { changes: ToolChange[]; skipped: number } {
  return bulk(server, tools, rules, scope, (t) => (toolNature(t).nature === "read" ? "allow" : "ask"));
}

/** Every tool of the server to the same rule (Allow all / Ask for all / Block all). */
export function setAll(
  server: string,
  tools: readonly ToolLike[],
  rules: readonly ToolRule[],
  kind: ToolRuleKind,
  scope: PermissionScope = "global",
): { changes: ToolChange[]; skipped: number } {
  return bulk(server, tools, rules, scope, () => kind);
}

/** Remove every rule of the scope's own for this server's tools. */
export function resetServer(
  server: string,
  tools: readonly Pick<McpToolInfo, "name">[],
  rules: readonly ToolRule[],
  scope: PermissionScope = "global",
): ToolChange[] {
  return tools
    .map((t) => mcpToolRuleName(server, t.name))
    .filter((tool) => toolPermissionState(tool, rules, scope).choice !== "default")
    .map((tool) => ({ tool, kind: null }));
}

/** How many of a server's tools are blocked / ask / allowed, for its collapsed row. */
export function serverSummary(
  server: string,
  tools: readonly Pick<McpToolInfo, "name">[],
  rules: readonly ToolRule[] | undefined,
): { deny: number; ask: number; allow: number } {
  const out = { deny: 0, ask: 0, allow: 0 };
  if (!rules) return out;
  for (const t of tools) {
    const k = resolvePermission(mcpToolRuleName(server, t.name), rules).kind;
    if (k) out[k]++;
  }
  return out;
}

// ---- A whole server on/off --------------------------------------------------------------

/** The rule that names a whole server (`mcp__claude_ai_Gmail`) — a `deny` on it turns the
 *  server off: every one of its tools leaves Claude's context. */
export function serverRuleName(server: string): string {
  return `mcp__${normalizeServerName(server)}`;
}

export interface ServerOffState {
  /** The server is off for this conversation, every source considered. */
  off: boolean;
  /** The scope itself turned it off (its own `deny` on the server rule). */
  ownOff: boolean;
  /** Another source turned it off — the scope can't turn it back on. */
  offBy: ToolRule | null;
}

/** Whether a server is off, and who turned it off. A server-wide deny is the server rule
 *  itself, `mcp__<server>__*`, or a broader glob (`mcp__*`, `*`) — never one tool's deny. */
export function serverOffState(server: string, rules: readonly ToolRule[], scope: PermissionScope): ServerOffState {
  const name = serverRuleName(server);
  // A tool name no real server uses: only a rule covering EVERY tool of the server matches it.
  const anyTool = `${name}__\u0001`;
  const wide = rules.filter((r) => r.kind === "deny" && ruleMatchesTool(r.rule, "deny", anyTool));
  const ownOff = wide.some((r) => r.source === OWN_SOURCE[scope] && r.rule === name);
  const offBy = wide.find((r) => !(r.source === OWN_SOURCE[scope] && r.rule === name)) ?? null;
  return { off: ownOff || offBy != null, ownOff, offBy };
}

// ---- Plugins on/off per scope -------------------------------------------------------------

/** One source's say on a plugin (`enabledPlugins[id]`): a settings file, or the
 *  conversation's session layer. */
export interface PluginSay {
  source: ToolRuleSource;
  enabled: boolean;
}

/** Highest precedence first — the flag layer (a conversation) ranks above every file but
 *  the organization's. */
const PLUGIN_ORDER: readonly ToolRuleSource[] = ["managed", "conversation", "local", "project", "user"];
/** The sources each scope inherits from when it says nothing itself. */
const PLUGIN_BELOW: Record<PermissionScope, readonly ToolRuleSource[]> = {
  conversation: ["local", "project", "user"],
  repository: ["project", "user"],
  global: [],
};

export interface PluginScopeState {
  /** On at this scope's level (its own say, else what it inherits). */
  enabled: boolean;
  /** The scope has a say of its own (else it follows the levels below). */
  own: boolean;
  /** What this scope would follow without a say of its own. */
  inherited: boolean;
  /** What this conversation actually gets, every level considered. */
  effective: boolean;
  /** The organization decides — nothing here can change it. */
  lockedByPolicy: boolean;
  /** A level ABOVE this scope decides differently for this conversation (e.g. the
   *  conversation overrides the repository's choice). */
  overriddenBy: ToolRuleSource | null;
}

/**
 * A plugin seen from one scope. `fallback` is what applies when no source says anything
 * (the plugin's installed state as the configuration scan reports it).
 */
export function pluginScopeState(
  says: readonly PluginSay[],
  scope: PermissionScope,
  fallback: boolean,
): PluginScopeState {
  const at = (s: ToolRuleSource) => says.find((x) => x.source === s)?.enabled;
  const firstOf = (order: readonly ToolRuleSource[]) => order.map(at).find((v) => v !== undefined);
  const ownVal = at(OWN_SOURCE[scope]);
  const inherited = firstOf(PLUGIN_BELOW[scope]) ?? fallback;
  const enabled = ownVal ?? inherited;
  const managed = at("managed");
  const effective = firstOf(PLUGIN_ORDER) ?? fallback;
  const above = PLUGIN_ORDER.slice(0, PLUGIN_ORDER.indexOf(OWN_SOURCE[scope]));
  const overriddenBy = above.find((s) => at(s) !== undefined && at(s) !== enabled) ?? null;
  return {
    enabled,
    own: ownVal !== undefined,
    inherited,
    effective,
    lockedByPolicy: managed !== undefined,
    overriddenBy,
  };
}

/** What to write when the user flips a plugin to `enabled` at a scope: nothing of its own
 *  (null) when that's what it would follow anyway — the files stay minimal — else the
 *  value. The global file always holds an explicit value. */
export function pluginWrite(state: PluginScopeState, enabled: boolean, scope: PermissionScope): boolean | null {
  return scope !== "global" && enabled === state.inherited ? null : enabled;
}

const SOURCE_LABEL: Record<ToolRuleSource, string> = {
  managed: "organization policy",
  conversation: "this conversation's settings",
  local: "this repository's local settings",
  project: "this repository's shared settings",
  user: "your global settings",
};

/** "this conversation's settings" — who decides, for a note or tooltip. */
export function describeSource(s: ToolRuleSource): string {
  return SOURCE_LABEL[s];
}

/** "`mcp__claude_ai_Gmail` in this project's shared settings" — names a rule for a tooltip. */
export function describeRule(r: ToolRule): string {
  return `${r.rule} in ${SOURCE_LABEL[r.source]}`;
}
