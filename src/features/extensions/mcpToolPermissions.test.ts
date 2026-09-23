import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../../ipc/client";
import {
  EMPTY_LEVEL,
  mcpToolRuleName,
  nativeResolve,
  normalizeServerName,
  pluginAt,
  pluginWrite,
  readOnlyPreset,
  resetServer,
  ruleMatchesTool,
  serverAt,
  serverInherited,
  serverRuleName,
  serverSummary,
  sessionOverridesFrom,
  setAll,
  toolAt,
  toolNature,
  toolRowState,
  type Cascade,
  type LevelPolicy,
} from "./mcpToolPermissions";

const GMAIL = "claude.ai Gmail";
const SEND = "mcp__claude_ai_Gmail__send_message";
const SEARCH = "mcp__claude_ai_Gmail__search_threads";
const SERVER = "mcp__claude_ai_Gmail";

const lvl = (p: Partial<LevelPolicy>): LevelPolicy => ({ ...EMPTY_LEVEL, ...p });
const ext = (rule: string, kind: PermissionRule["kind"], source: PermissionRule["source"] = "user"): PermissionRule => ({
  rule,
  kind,
  source,
  path: "",
});

describe("names (mirror of the CLI's normalization)", () => {
  it("names a claude.ai connector's tools and server the way the CLI does", () => {
    expect(normalizeServerName("claude.ai Google Calendar")).toBe("claude_ai_Google_Calendar");
    expect(mcpToolRuleName(GMAIL, "send_message")).toBe(SEND);
    expect(serverRuleName(GMAIL)).toBe(SERVER);
    expect(normalizeServerName("plugin:railway:railway")).toBe("plugin_railway_railway");
  });
});

describe("the cascade: the narrowest level wins, both ways", () => {
  it("a repository can LOOSEN a cautious global setting", () => {
    const c: Cascade = { global: lvl({ tools: { [SEND]: "deny" } }), repository: lvl({ tools: { [SEND]: "allow" } }) };
    expect(toolAt(c, "global", SEND).kind).toBe("deny");
    expect(toolAt(c, "repository", SEND).kind).toBe("allow");
    expect(toolAt(c, "conversation", SEND)).toEqual({ kind: "allow", from: { level: "repository", via: "tool" } });
  });

  it("a scope never sees a narrower level's setting", () => {
    const c: Cascade = { conversation: lvl({ tools: { [SEND]: "deny" } }) };
    expect(toolAt(c, "repository", SEND).kind).toBeNull();
    expect(toolAt(c, "global", SEND).kind).toBeNull();
    expect(toolAt(c, "conversation", SEND).kind).toBe("deny");
  });

  it("within a level, a tool's own setting beats its server's", () => {
    const c: Cascade = { global: lvl({ servers: { [SERVER]: false }, tools: { [SEARCH]: "allow" } }) };
    expect(toolAt(c, "global", SEARCH).kind).toBe("allow");
    expect(toolAt(c, "global", SEND)).toEqual({ kind: "deny", from: { level: "global", via: "server" } });
  });

  it("a server turned off globally can be turned back on for one conversation", () => {
    const c: Cascade = { global: lvl({ servers: { [SERVER]: false } }), conversation: lvl({ servers: { [SERVER]: true } }) };
    expect(serverAt(c, "global", GMAIL).on).toBe(false);
    expect(serverAt(c, "conversation", GMAIL)).toEqual({ on: true, own: true, from: "conversation", locked: false });
    expect(serverInherited(c, "conversation", GMAIL)).toBe(false);
    expect(toolAt(c, "conversation", SEND).kind).toBeNull();
  });
});

describe("a tool row", () => {
  it("shows the scope's own choice, else what it inherits and from where", () => {
    const c: Cascade = { global: lvl({ tools: { [SEND]: "ask" } }) };
    const s = toolRowState(c, "repository", SEND, []);
    expect(s.choice).toBe("default");
    expect(s.shown).toBe("ask");
    expect(s.from).toEqual({ level: "global", via: "tool" });
  });

  it("Claude Code's files are the baseline 'Default' falls back to", () => {
    const s = toolRowState({}, "global", SEND, [ext(SERVER, "ask", "project")]);
    expect(s.choice).toBe("default");
    expect(s.shown).toBe("ask");
    expect(s.from).toEqual({ level: "claude", via: "tool" });
  });

  it("Flight Deck overrides a file's ask — every choice stays offered", () => {
    const c: Cascade = { global: lvl({ tools: { [SEND]: "allow" } }) };
    const s = toolRowState(c, "global", SEND, [ext(SEND, "ask")]);
    expect(s.impossible.size).toBe(0);
    expect(s.shown).toBe("allow");
  });

  it("only what Claude Code really enforces is not offered: a file deny, the org's ask", () => {
    expect([...toolRowState({}, "conversation", SEND, [ext(SERVER, "deny", "user")]).impossible].sort()).toEqual(["allow", "ask"]);
    expect([...toolRowState({}, "conversation", SEND, [ext(SEND, "ask", "managed")]).impossible]).toEqual(["allow"]);
    // A choice set before the file denied it isn't shown as if it applied.
    const s = toolRowState({ conversation: lvl({ tools: { [SEND]: "allow" } }) }, "conversation", SEND, [ext(SEND, "deny")]);
    expect(s.choice).toBe("default");
    expect(s.shown).toBe("deny");
  });

  it("a server Claude Code turns off entirely stays off, locked", () => {
    const st = serverAt({ global: lvl({ servers: { [SERVER]: true } }) }, "global", GMAIL, [ext(SERVER, "deny")]);
    expect(st).toMatchObject({ on: false, locked: true });
    expect(serverAt({}, "global", GMAIL, [ext(SEND, "deny")]).locked).toBe(false); // one tool only
  });
});

describe("what a conversation's session receives", () => {
  it("one rule per tool, the narrowest one", () => {
    const c: Cascade = {
      global: lvl({ tools: { [SEND]: "deny", [SEARCH]: "ask" } }),
      repository: lvl({ tools: { [SEND]: "allow" } }),
    };
    expect(sessionOverridesFrom(c, {})).toEqual({ allow: [SEND], ask: [SEARCH], deny: [], enabled_plugins: {} });
  });

  it("a server off is one deny — or a deny per OTHER tool when some are re-allowed below", () => {
    const off: Cascade = { global: lvl({ servers: { [SERVER]: false } }) };
    expect(sessionOverridesFrom(off, {}).deny).toEqual([SERVER]);
    const except: Cascade = { ...off, conversation: lvl({ tools: { [SEARCH]: "allow" } }) };
    const o = sessionOverridesFrom(except, { [SERVER]: ["search_threads", "send_message", "get_message"] });
    expect(o.allow).toEqual([SEARCH]);
    expect(o.deny).toEqual(["mcp__claude_ai_Gmail__get_message", SEND]);
  });

  it("a server back on below undoes the broader off", () => {
    const c: Cascade = { global: lvl({ servers: { [SERVER]: false } }), repository: lvl({ servers: { [SERVER]: true } }) };
    expect(sessionOverridesFrom(c, {}).deny).toEqual([]);
  });

  it("plugins: the conversation's say beats the repository's", () => {
    const c: Cascade = {
      repository: lvl({ plugins: { "a@m": false, "b@m": true } }),
      conversation: lvl({ plugins: { "a@m": true } }),
    };
    expect(sessionOverridesFrom(c, {}).enabled_plugins).toEqual({ "a@m": true, "b@m": true });
  });
});

describe("plugins per scope", () => {
  const files = [{ source: "user" as const, enabled: true }];

  it("Global is Claude Code's own setting; narrower levels override it both ways", () => {
    const c: Cascade = { repository: lvl({ plugins: { "p@m": false } }) };
    expect(pluginAt(c, "global", "p@m", files, false).enabled).toBe(true);
    expect(pluginAt(c, "repository", "p@m", files, false)).toMatchObject({ enabled: false, own: true, inherited: true });
    expect(pluginAt(c, "conversation", "p@m", files, false)).toMatchObject({ enabled: false, own: false });
  });

  it("writes nothing of its own when it matches what it would follow", () => {
    const st = pluginAt({}, "conversation", "p@m", files, false);
    expect(pluginWrite(st, true, "conversation")).toBeNull();
    expect(pluginWrite(st, false, "conversation")).toBe(false);
    expect(pluginWrite(pluginAt({}, "global", "p@m", files, false), true, "global")).toBe(true);
  });

  it("the organization's policy locks it", () => {
    expect(pluginAt({}, "conversation", "p@m", [{ source: "managed", enabled: false }], true).lockedByPolicy).toBe(true);
  });
});

describe("Claude Code's own rules", () => {
  it("match exact names, whole servers and globs — and not a sibling", () => {
    expect(ruleMatchesTool(SERVER, "deny", SEND)).toBe(true);
    expect(ruleMatchesTool("mcp__claude_ai_Gmail__*", "allow", SEND)).toBe(true);
    expect(ruleMatchesTool("mcp__*", "allow", SEND)).toBe(false); // the CLI skips it
    expect(ruleMatchesTool("mcp__claude_ai_Gmail__send", "deny", SEND)).toBe(false);
  });

  it("resolve deny > ask > allow, whatever the file", () => {
    expect(nativeResolve(SEND, [ext(SEND, "allow"), ext(SERVER, "deny", "project")])?.kind).toBe("deny");
  });
});

describe("batch actions write the scope's own settings", () => {
  const tools = [
    { name: "search_threads", read_only: true, destructive: null },
    { name: "send_message", read_only: false, destructive: true },
  ];

  it("read-only preset: reads allowed, the rest asks — only what changes", () => {
    expect(readOnlyPreset({}, "conversation", GMAIL, tools)).toEqual([
      { tool: SEARCH, kind: "allow" },
      { tool: SEND, kind: "ask" },
    ]);
    const c: Cascade = { conversation: lvl({ tools: { [SEND]: "ask" } }) };
    expect(readOnlyPreset(c, "conversation", GMAIL, tools)).toEqual([{ tool: SEARCH, kind: "allow" }]);
  });

  it("allow / ask / block all, and reset clears only this scope's own", () => {
    expect(setAll({}, "global", GMAIL, tools, "deny").map((c) => c.kind)).toEqual(["deny", "deny"]);
    const c: Cascade = { global: lvl({ tools: { [SEND]: "deny" } }), repository: lvl({ tools: { [SEARCH]: "ask" } }) };
    expect(resetServer(c, "repository", GMAIL, tools)).toEqual([{ tool: SEARCH, kind: null }]);
  });

  it("summarizes what a server's tools get at a scope", () => {
    const c: Cascade = { global: lvl({ tools: { [SEND]: "deny" } }), repository: lvl({ tools: { [SEARCH]: "ask" } }) };
    expect(serverSummary(c, "repository", GMAIL, tools)).toEqual({ deny: 1, ask: 1, allow: 0 });
    expect(serverSummary(c, "global", GMAIL, tools)).toEqual({ deny: 1, ask: 0, allow: 0 });
  });
});

describe("toolNature", () => {
  it("trusts the server's annotations first, else guesses from the name erring toward write", () => {
    expect(toolNature({ name: "send_message", read_only: true, destructive: null })).toEqual({ nature: "read", from: "annotation" });
    const n = (name: string) => toolNature({ name, read_only: null, destructive: null }).nature;
    expect(n("search_threads")).toBe("read");
    expect(n("get_draft")).toBe("read");
    expect(n("slack_send_message")).toBe("write");
    expect(n("listEvents")).toBe("read");
    expect(n("suggest_time")).toBe("write");
  });
});
