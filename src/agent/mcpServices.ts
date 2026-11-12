// Well-known services behind MCP tool calls: which product a `mcp__<server>__<tool>` call
// went to, so the transcript can wear that product's logo and name ("Gmail · 3 tools")
// instead of the anonymous plug and the transport's spelling ("claude ai Gmail · 3 tools").
// Pure + framework-free: shared by the step icon, the step label and the run header, so the
// live thread and the off-thread transcript agree.
//
// TOSSE and Flight Deck are NOT here: they have their own, richer rendering (tosseTool.ts,
// flightdeckTool.ts), resolved before this registry is consulted.
//
// ⚠️ Matching is by EXACT normalised server name, never by "contains": a server called
// `notion_backup_tool` is not Notion, and wearing a brand's logo on someone else's server
// would be a lie. The same service reaches us under several spellings, all reduced to one key:
//  - the claude.ai connector:  `claude_ai_Google_Calendar` → `googlecalendar`
//  - a plugin-bundled server:  `plugin_railway_railway`    → server part `railway`
//  - a local server:           `XcodeBuildMCP`, `apple-docs` → `xcodebuild`, `appledocs`
//  - Codex (already `mcp__<server>__<tool>` on our side): the server name as configured.

import { parseMcpToolName } from "./toolNames";

export interface McpService {
  /** Key of the service's mark in `SERVICE_MARK_ART` (src/ui/serviceMarkArt.ts). */
  id: string;
  /** The product name the user knows it by. */
  label: string;
}

/** id, label, then every normalised server name (lowercase, alphanumerics only) it answers
 *  to. Order is irrelevant; an alias must belong to ONE service. */
const SERVICES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["gmail", "Gmail", ["gmail", "googlemail"]],
  ["gcal", "Google Calendar", ["googlecalendar", "gcal"]],
  ["gdrive", "Google Drive", ["googledrive", "gdrive"]],
  ["gdocs", "Google Docs", ["googledocs", "gdocs"]],
  ["gsheets", "Google Sheets", ["googlesheets", "gsheets"]],
  ["qonto", "Qonto", ["qonto"]],
  ["playwright", "Playwright", ["playwright"]],
  ["claudedocs", "Claude Docs", ["claudedocs"]],
  ["railway", "Railway", ["railway"]],
  ["ryanair", "Ryanair", ["ryanair"]],
  ["kiwi", "Kiwi.com", ["kiwicom", "kiwi"]],
  ["aqua", "Aqua Voice", ["aquavoice"]],
  ["appledocs", "Apple Docs", ["appledocs"]],
  ["xcode", "Xcode", ["xcodebuild", "xcode"]],
  ["github", "GitHub", ["github"]],
  // `notionApi` is the official local server's default name (@notionhq/notion-mcp-server).
  ["notion", "Notion", ["notion", "notionapi"]],
  ["slack", "Slack", ["slack"]],
  ["linear", "Linear", ["linear"]],
  ["figma", "Figma", ["figma", "figmadevmode"]],
  ["stripe", "Stripe", ["stripe"]],
];

const BY_ALIAS: ReadonlyMap<string, McpService> = new Map(
  SERVICES.flatMap(([id, label, aliases]) => aliases.map((a) => [a, { id, label }] as const)),
);

/** Prefix of an <Ico> name asking for a service's logo (`svc:gmail`): <Ico> routes it to
 *  <ServiceMark>, the way it routes `tosse` / `flightdeck` to their own marks. */
export const SERVICE_ICON_PREFIX = "svc:";

/** Every service id the registry can return — the art table must cover each one (tested). */
export const MCP_SERVICE_IDS: readonly string[] = SERVICES.map(([id]) => id);

const CLAUDE_AI = "claudeai";
const PLUGIN_PREFIX = "plugin_";

/** The service behind a raw server segment, or null for one we don't know. */
export function mcpServiceForServer(server: string): McpService | null {
  // A plugin-bundled server is `plugin_<plugin>_<server>`: the plugin's name (kebab-case) ends
  // at the first underscore, and only the server part names the service.
  if (server.startsWith(PLUGIN_PREFIX)) {
    const rest = server.slice(PLUGIN_PREFIX.length);
    const sep = rest.indexOf("_");
    return sep > 0 ? mcpServiceForServer(rest.slice(sep + 1)) : null;
  }
  let key = server.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key.startsWith(CLAUDE_AI) && key.length > CLAUDE_AI.length) key = key.slice(CLAUDE_AI.length);
  const hit = BY_ALIAS.get(key);
  if (hit) return hit;
  // `XcodeBuildMCP`, `github-mcp`: a trailing "mcp" names the protocol, not the product.
  if (key.endsWith("mcp") && key.length > 3) return BY_ALIAS.get(key.slice(0, -3)) ?? null;
  return null;
}

/** The service behind a full tool name (`mcp__<server>__<tool>`), or null — a non-MCP tool,
 *  or a server we don't know. */
export function mcpServiceFor(toolName: string): McpService | null {
  const p = parseMcpToolName(toolName);
  return p ? mcpServiceForServer(p.server) : null;
}

/** "<product> : <tool>" for a known service ("Gmail : search_threads") — the generic MCP
 *  label with the product's name in place of the transport's spelling. null otherwise. */
export function mcpServiceStepLabel(toolName: string): string | null {
  const p = parseMcpToolName(toolName);
  if (!p) return null;
  const s = mcpServiceForServer(p.server);
  return s ? `${s.label} : ${p.tool}` : null;
}
