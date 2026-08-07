import { describe, expect, it } from "vitest";
import type { MarketplaceInfo, PluginInfo } from "../../ipc/client";
import {
  allMarketplacesAuto,
  cliScope,
  totalUpdates,
  updateBadgeLabel,
  updatesForMarketplace,
} from "./pluginUpdates";

/** Minimal PluginInfo factory — only the fields the derivations read. */
function plugin(over: Partial<PluginInfo>): PluginInfo {
  return {
    id: "p@m",
    name: "p",
    marketplace: "m",
    version: null,
    description: null,
    enabled: true,
    scope: "user",
    update_unproven: false,
  update_available: false,
    latest_version: null,
    skill_count: 0,
    agent_count: 0,
    command_count: 0,
    mcp_count: 0,
    ...over,
  };
}

const mkt = (name: string, auto_update: boolean): MarketplaceInfo => ({ name, source: "", auto_update });

describe("cliScope", () => {
  it("passes user/project/local through and drops plugin", () => {
    expect(cliScope("user")).toBe("user");
    expect(cliScope("project")).toBe("project");
    expect(cliScope("local")).toBe("local");
    expect(cliScope("plugin")).toBeNull();
  });
});

describe("updateBadgeLabel", () => {
  it("shows vX → vY only when both versions are known and differ", () => {
    expect(updateBadgeLabel("1.0.0", "1.1.0")).toBe("v1.0.0 → v1.1.0");
  });
  it("falls back to a generic label for sha-only bumps or unknown versions", () => {
    expect(updateBadgeLabel("1.0.0", "1.0.0")).toBe("Update available");
    expect(updateBadgeLabel(null, "1.1.0")).toBe("Update available");
    expect(updateBadgeLabel("1.0.0", null)).toBe("Update available");
  });
});

describe("update counts", () => {
  const plugins = [
    plugin({ id: "a@m1", marketplace: "m1", update_available: true }),
    plugin({ id: "b@m1", marketplace: "m1", update_available: false }),
    plugin({ id: "c@m2", marketplace: "m2", update_available: true }),
  ];
  it("counts per marketplace", () => {
    expect(updatesForMarketplace(plugins, "m1")).toBe(1);
    expect(updatesForMarketplace(plugins, "m2")).toBe(1);
    expect(updatesForMarketplace(plugins, "none")).toBe(0);
  });
  it("counts the total across marketplaces", () => {
    expect(totalUpdates(plugins)).toBe(2);
    expect(totalUpdates([])).toBe(0);
  });
});

describe("allMarketplacesAuto", () => {
  it("is on only when non-empty and all enabled", () => {
    expect(allMarketplacesAuto([mkt("a", true), mkt("b", true)])).toBe(true);
    expect(allMarketplacesAuto([mkt("a", true), mkt("b", false)])).toBe(false);
    expect(allMarketplacesAuto([])).toBe(false);
  });
});
