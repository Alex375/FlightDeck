import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../../ipc/client";
import {
  mcpToolRuleName,
  normalizeServerName,
  readOnlyPreset,
  resetServer,
  resolvePermission,
  ruleMatchesTool,
  serverSummary,
  setAll,
  toolNature,
  toolPermissionState,
  type ToolRule,
} from "./mcpToolPermissions";

const SEND = "mcp__claude_ai_Gmail__send_message";
const SEARCH = "mcp__claude_ai_Gmail__search_threads";

const rule = (r: string, kind: PermissionRule["kind"], source: PermissionRule["source"] = "user"): PermissionRule => ({
  rule: r,
  kind,
  source,
  path: `/${source}.json`,
});

describe("tool rule names (mirror of the CLI's normalization)", () => {
  it("names a claude.ai connector's tools the way the CLI does", () => {
    expect(normalizeServerName("claude.ai Gmail")).toBe("claude_ai_Gmail");
    expect(normalizeServerName("claude.ai Google Calendar")).toBe("claude_ai_Google_Calendar");
    expect(mcpToolRuleName("claude.ai Gmail", "send_message")).toBe(SEND);
  });

  it("keeps a plugin server's separators as the CLI does (no collapsing outside claude.ai)", () => {
    expect(normalizeServerName("plugin:railway:railway")).toBe("plugin_railway_railway");
    expect(mcpToolRuleName("Railway", "list-projects")).toBe("mcp__Railway__list-projects");
  });

  it("leaves an already-qualified name alone", () => {
    expect(mcpToolRuleName("claude.ai Gmail", SEND)).toBe(SEND);
  });
});

describe("which rules reach a tool", () => {
  it("exact name, whole server, and globs", () => {
    expect(ruleMatchesTool(SEND, "deny", SEND)).toBe(true);
    expect(ruleMatchesTool("mcp__claude_ai_Gmail", "ask", SEND)).toBe(true);
    expect(ruleMatchesTool("mcp__claude_ai_Gmail__*", "allow", SEND)).toBe(true);
    expect(ruleMatchesTool("mcp__*", "deny", SEND)).toBe(true);
    expect(ruleMatchesTool("*", "ask", SEND)).toBe(true);
  });

  it("does not let one tool's rule or a sibling server reach another", () => {
    expect(ruleMatchesTool(SEARCH, "deny", SEND)).toBe(false);
    expect(ruleMatchesTool("mcp__claude_ai_Gmai", "deny", SEND)).toBe(false);
    expect(ruleMatchesTool("mcp__claude_ai_Gmail__send", "deny", SEND)).toBe(false);
  });

  it("ignores an allow glob with no literal server prefix, as the CLI does", () => {
    expect(ruleMatchesTool("mcp__*", "allow", SEND)).toBe(false);
    expect(ruleMatchesTool("*", "allow", SEND)).toBe(false);
  });
});

describe("resolution: deny > ask > allow, whatever the file", () => {
  it("a project deny beats the user's allow", () => {
    const r = resolvePermission(SEND, [rule(SEND, "allow"), rule("mcp__claude_ai_Gmail", "deny", "project")]);
    expect(r.kind).toBe("deny");
    expect(r.rule?.source).toBe("project");
  });

  it("a server-wide ask beats a per-tool allow", () => {
    expect(resolvePermission(SEND, [rule(SEND, "allow"), rule("mcp__claude_ai_Gmail", "ask")]).kind).toBe("ask");
  });

  it("no rule: the mode decides", () => {
    expect(resolvePermission(SEND, [rule(SEARCH, "deny")])).toEqual({ kind: null, rule: null });
  });
});

describe("toolPermissionState", () => {
  it("reads the user's own exact rule as the current choice", () => {
    const s = toolPermissionState(SEND, [rule(SEND, "ask")]);
    expect(s.choice).toBe("ask");
    expect(s.effective.kind).toBe("ask");
    expect(s.inherited.kind).toBeNull();
    expect(Object.values(s.options).every((o) => o.holds)).toBe(true);
  });

  it("never offers a choice another rule would override, and says which rule", () => {
    const s = toolPermissionState(SEND, [rule("mcp__claude_ai_Gmail", "deny", "project")]);
    expect(s.choice).toBe("default");
    expect(s.options.allow.holds).toBe(false);
    expect(s.options.ask.holds).toBe(false);
    expect(s.options.deny.holds).toBe(true);
    expect(s.options.allow.blockedBy?.rule).toBe("mcp__claude_ai_Gmail");
  });

  it("an ask elsewhere still lets the user block, but not allow", () => {
    const s = toolPermissionState(SEND, [rule("mcp__claude_ai_Gmail__*", "ask")]);
    expect(s.options.deny.holds).toBe(true);
    expect(s.options.ask.holds).toBe(true);
    expect(s.options.allow.holds).toBe(false);
  });

  it("'Default' shows what applies without the user's rule", () => {
    const s = toolPermissionState(SEND, [rule(SEND, "deny"), rule("mcp__claude_ai_Gmail", "allow")]);
    expect(s.choice).toBe("deny");
    expect(s.inherited.kind).toBe("allow");
  });

  it("a rule with the same name in a project file is not the user's own", () => {
    const s = toolPermissionState(SEND, [rule(SEND, "ask", "project")]);
    expect(s.choice).toBe("default");
    expect(s.effective.kind).toBe("ask");
  });
});

describe("toolNature", () => {
  it("trusts the server's annotations first", () => {
    expect(toolNature({ name: "send_message", read_only: true, destructive: null })).toEqual({ nature: "read", from: "annotation" });
    expect(toolNature({ name: "search", read_only: null, destructive: true })).toEqual({ nature: "write", from: "annotation" });
  });

  it("guesses from the name otherwise, erring toward write", () => {
    const n = (name: string) => toolNature({ name, read_only: null, destructive: null }).nature;
    expect(n("search_threads")).toBe("read");
    expect(n("slack_read_channel")).toBe("read");
    expect(n("list_drafts")).toBe("read");
    expect(n("get_draft")).toBe("read");
    expect(n("send_message")).toBe("write");
    expect(n("slack_send_message")).toBe("write");
    expect(n("create_draft")).toBe("write");
    expect(n("mark_thread_spam")).toBe("write");
    expect(n("listEvents")).toBe("read");
    expect(n("suggest_time")).toBe("write"); // neither word → ask, never silently allowed
    expect(toolNature({ name: "search_threads", read_only: null, destructive: null }).from).toBe("name");
  });
});

describe("batch actions", () => {
  const tools = [
    { name: "search_threads", read_only: true, destructive: null },
    { name: "send_message", read_only: false, destructive: true },
  ];

  it("read-only preset: reads allowed, the rest asks", () => {
    const { changes, skipped } = readOnlyPreset("claude.ai Gmail", tools, []);
    expect(changes).toEqual([
      { tool: SEARCH, kind: "allow" },
      { tool: SEND, kind: "ask" },
    ]);
    expect(skipped).toBe(0);
  });

  it("read-only preset skips what a stricter rule overrides, and what is already set", () => {
    const { changes, skipped } = readOnlyPreset("claude.ai Gmail", tools, [
      rule("mcp__claude_ai_Gmail", "ask", "project"), // allow can't hold for search
      rule(SEND, "ask"), // already the preset's value
    ]);
    expect(changes).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("reset clears only the user's own rules", () => {
    expect(resetServer("claude.ai Gmail", tools, [rule(SEND, "deny"), rule(SEARCH, "ask", "project")])).toEqual([
      { tool: SEND, kind: null },
    ]);
  });

  it("summarizes what applies across a server's tools", () => {
    expect(serverSummary("claude.ai Gmail", tools, [rule(SEND, "deny"), rule(SEARCH, "ask")])).toEqual({
      deny: 1,
      ask: 1,
      allow: 0,
    });
  });

  it("allow / ask / block all — only what would hold, only what changes", () => {
    expect(setAll("claude.ai Gmail", tools, [], "deny").changes).toEqual([
      { tool: SEARCH, kind: "deny" },
      { tool: SEND, kind: "deny" },
    ]);
    // A global ask on the server: "allow all" can't hold for either tool.
    const r = setAll("claude.ai Gmail", tools, [rule("mcp__claude_ai_Gmail", "ask")], "allow");
    expect(r).toEqual({ changes: [], skipped: 2 });
  });
});

describe("the conversation scope", () => {
  const conv = (r: string, kind: ToolRule["kind"]): ToolRule => ({ rule: r, kind, source: "conversation", path: "" });

  it("manages the conversation's own rules, not the user file's", () => {
    const s = toolPermissionState(SEND, [rule(SEND, "allow"), conv(SEND, "deny")], "conversation");
    expect(s.choice).toBe("deny");
    expect(s.inherited.kind).toBe("allow"); // what the conversation gets from the global rules
    expect(toolPermissionState(SEND, [rule(SEND, "allow"), conv(SEND, "deny")], "global").choice).toBe("allow");
  });

  it("can tighten a global rule but never loosen it", () => {
    const s = toolPermissionState(SEND, [rule(SEND, "ask")], "conversation");
    expect(s.options.deny.holds).toBe(true);
    expect(s.options.allow.holds).toBe(false);
    expect(s.options.allow.blockedBy?.source).toBe("user");
  });

  it("a conversation's rule shows up in the global view as something that applies there", () => {
    const s = toolPermissionState(SEND, [conv(SEND, "deny")], "global");
    expect(s.choice).toBe("default");
    expect(s.effective.kind).toBe("deny");
  });

  it("read-only preset and reset work on the conversation's own rules", () => {
    const tools = [{ name: "send_message", read_only: null, destructive: null }];
    expect(readOnlyPreset("claude.ai Gmail", tools, [], "conversation").changes).toEqual([{ tool: SEND, kind: "ask" }]);
    expect(resetServer("claude.ai Gmail", tools, [rule(SEND, "deny"), conv(SEND, "ask")], "conversation")).toEqual([
      { tool: SEND, kind: null },
    ]);
  });
});
