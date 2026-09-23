// Per-tool permission for MCP tools — the pure half. Resolves Claude Code's own
// `permissions.allow` / `ask` / `deny` rules (read by the Rust `extensions::permissions`
// module from every settings file) into what the UI needs for one tool: the user's own
// choice, what REALLY applies, and which choices would actually hold.
//
// The CLI's semantics, mirrored here (docs + binary 2.1.280):
//   • deny > ask > allow — whatever the rule's specificity or the file it sits in, so a
//     project `deny` beats a user `allow`, and a server-wide `ask` beats a per-tool `allow`.
//   • `mcp__<server>` matches every tool of that server; deny/ask accept a glob anywhere in
//     the tool name (`*`, `mcp__*`), allow only after a literal `mcp__<server>__` prefix.
//   • The app writes ONE kind of rule: the exact tool name, in the user's own settings file.
//     A choice another rule would override is never offered as if it would take effect.
import type {
  McpToolInfo,
  PermissionRule,
  PermissionRulesView,
  ToolRuleKind,
} from "../../ipc/client";

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
  rule: PermissionRule | null;
}

const KIND_RANK: Record<ToolRuleKind, number> = { deny: 0, ask: 1, allow: 2 };
const SOURCE_RANK: Record<PermissionRule["source"], number> = { managed: 0, local: 1, project: 2, user: 3 };

/** deny > ask > allow; among equals, the most authoritative file is the one named. */
export function resolvePermission(tool: string, rules: readonly PermissionRule[]): Resolution {
  const best = rules
    .filter((r) => ruleMatchesTool(r.rule, r.kind, tool))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0];
  return best ? { kind: best.kind, rule: best } : { kind: null, rule: null };
}

/** A rule the app manages for this tool: its exact name, in the user's own file. */
const isOwn = (r: PermissionRule, tool: string) => r.source === "user" && r.rule === tool;

export interface ChoiceOption {
  /** Picking it would really be what applies. */
  holds: boolean;
  /** When it wouldn't: the rule that wins instead. */
  blockedBy: PermissionRule | null;
}

export interface ToolPermissionState {
  /** The full rule name (`mcp__claude_ai_Gmail__send_message`). */
  tool: string;
  /** The user's own rule for the tool, or "default" when they have none. */
  choice: ToolChoice;
  /** What really applies, all files considered. */
  effective: Resolution;
  /** What would apply with no rule of the user's own — what "Default" means for this tool. */
  inherited: Resolution;
  options: Record<ToolChoice, ChoiceOption>;
}

export function toolPermissionState(tool: string, rules: readonly PermissionRule[]): ToolPermissionState {
  const own = rules.filter((r) => isOwn(r, tool));
  const others = rules.filter((r) => !isOwn(r, tool));
  const choice: ToolChoice = own.length
    ? [...own].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0].kind
    : "default";
  const inherited = resolvePermission(tool, others);
  const option = (kind: ToolRuleKind): ChoiceOption => {
    const mine: PermissionRule = { rule: tool, kind, source: "user", path: "" };
    const r = resolvePermission(tool, [...others, mine]);
    return r.kind === kind ? { holds: true, blockedBy: null } : { holds: false, blockedBy: r.rule };
  };
  return {
    tool,
    choice,
    effective: resolvePermission(tool, rules),
    inherited,
    // "Default" always holds: it only removes the user's own rule.
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

/**
 * The "read-only" preset for one server: reads allowed, everything else asks first. Only
 * choices that would hold are written (one that a stricter rule elsewhere overrides is
 * skipped, and counted, rather than written as a rule that does nothing), and only where
 * the choice changes.
 */
export function readOnlyPreset(
  server: string,
  tools: readonly Pick<McpToolInfo, "name" | "read_only" | "destructive">[],
  rules: readonly PermissionRule[],
): { changes: ToolChange[]; skipped: number } {
  const changes: ToolChange[] = [];
  let skipped = 0;
  for (const t of tools) {
    const tool = mcpToolRuleName(server, t.name);
    const want: ToolRuleKind = toolNature(t).nature === "read" ? "allow" : "ask";
    const s = toolPermissionState(tool, rules);
    if (!s.options[want].holds) skipped++;
    else if (s.choice !== want) changes.push({ tool, kind: want });
  }
  return { changes, skipped };
}

/** Remove every rule of the user's own for this server's tools. */
export function resetServer(
  server: string,
  tools: readonly Pick<McpToolInfo, "name">[],
  rules: readonly PermissionRule[],
): ToolChange[] {
  return tools
    .map((t) => mcpToolRuleName(server, t.name))
    .filter((tool) => toolPermissionState(tool, rules).choice !== "default")
    .map((tool) => ({ tool, kind: null }));
}

/** How many of a server's tools are blocked / ask, for the collapsed row's summary. */
export function serverSummary(
  server: string,
  tools: readonly Pick<McpToolInfo, "name">[],
  view: PermissionRulesView | undefined,
): { deny: number; ask: number; allow: number } {
  const out = { deny: 0, ask: 0, allow: 0 };
  if (!view) return out;
  for (const t of tools) {
    const k = resolvePermission(mcpToolRuleName(server, t.name), view.rules).kind;
    if (k) out[k]++;
  }
  return out;
}

const SOURCE_LABEL: Record<PermissionRule["source"], string> = {
  managed: "organization policy",
  local: "this project's local settings",
  project: "this project's shared settings",
  user: "your user settings",
};

/** "`mcp__claude_ai_Gmail` in this project's shared settings" — names a rule for a tooltip. */
export function describeRule(r: PermissionRule): string {
  return `${r.rule} in ${SOURCE_LABEL[r.source]}`;
}
