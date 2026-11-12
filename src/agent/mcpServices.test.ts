import { describe, expect, it } from "vitest";
import {
  MCP_SERVICE_IDS,
  mcpServiceFor,
  mcpServiceForServer,
  mcpServiceStepLabel,
} from "./mcpServices";
import { SERVICE_MARK_ART } from "../ui/serviceMarkArt";

describe("mcpServiceForServer", () => {
  it("reads the claude.ai connector spelling", () => {
    expect(mcpServiceForServer("claude_ai_Gmail")?.label).toBe("Gmail");
    expect(mcpServiceForServer("claude_ai_Google_Calendar")?.label).toBe("Google Calendar");
    expect(mcpServiceForServer("claude_ai_Google_Drive")?.id).toBe("gdrive");
    expect(mcpServiceForServer("claude_ai_Qonto")?.id).toBe("qonto");
    expect(mcpServiceForServer("claude_ai_Claude_Docs")?.label).toBe("Claude Docs");
    expect(mcpServiceForServer("claude_ai_Kiwi_com")?.label).toBe("Kiwi.com");
    expect(mcpServiceForServer("claude_ai_Aqua_Voice")?.id).toBe("aqua");
  });

  it("reads local and plugin-bundled servers", () => {
    expect(mcpServiceForServer("playwright")?.id).toBe("playwright");
    expect(mcpServiceForServer("apple-docs")?.label).toBe("Apple Docs");
    expect(mcpServiceForServer("XcodeBuildMCP")?.label).toBe("Xcode");
    expect(mcpServiceForServer("plugin_railway_railway")?.label).toBe("Railway");
    expect(mcpServiceForServer("plugin_my-plugin_github")?.id).toBe("github");
    expect(mcpServiceForServer("notionApi")?.id).toBe("notion");
  });

  it("never wears a brand on a server that only CONTAINS its name", () => {
    expect(mcpServiceForServer("notion_backup_tool")).toBeNull();
    expect(mcpServiceForServer("my_gmail_archiver")).toBeNull();
    expect(mcpServiceForServer("plugin_gmail_database-tools")).toBeNull();
    expect(mcpServiceForServer("claude_ai")).toBeNull();
    expect(mcpServiceForServer("mcp")).toBeNull();
  });

  it("leaves TOSSE and Flight Deck to their own renderings", () => {
    expect(mcpServiceForServer("claude_ai_TOSSE")).toBeNull();
    expect(mcpServiceForServer("tosse")).toBeNull();
    expect(mcpServiceForServer("flightdeck")).toBeNull();
  });
});

describe("mcpServiceFor / mcpServiceStepLabel", () => {
  it("resolves a full tool name", () => {
    expect(mcpServiceFor("mcp__claude_ai_Gmail__search_threads")?.id).toBe("gmail");
    expect(mcpServiceFor("Read")).toBeNull();
    expect(mcpServiceFor("mcp__acme__do_thing")).toBeNull();
  });

  it("names the product in place of the transport", () => {
    expect(mcpServiceStepLabel("mcp__claude_ai_Gmail__search_threads")).toBe("Gmail : search_threads");
    expect(mcpServiceStepLabel("mcp__plugin_railway_railway__list_services")).toBe(
      "Railway : list_services",
    );
    expect(mcpServiceStepLabel("mcp__acme__do_thing")).toBeNull();
    expect(mcpServiceStepLabel("Bash")).toBeNull();
  });
});

describe("service mark art", () => {
  it("has a mark for every service the registry can return", () => {
    for (const id of MCP_SERVICE_IDS) expect(SERVICE_MARK_ART[id], id).toBeDefined();
  });

  it("ships no mark the registry cannot return", () => {
    expect(Object.keys(SERVICE_MARK_ART).sort()).toEqual([...MCP_SERVICE_IDS].sort());
  });
});
