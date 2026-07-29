import { describe, it, expect } from "vitest";
import { shouldShowClaudeCliBanner } from "./claudeCliUpdate";
import type { ClaudeCliStatus } from "../ipc/bindings";

const base: ClaudeCliStatus = {
  installed_version: "2.1.218",
  latest_version: "2.1.220",
  update_available: true,
  auto_update_enabled: true,
  install_method: "native",
  channel: "latest",
  config_warning: null,
};

describe("shouldShowClaudeCliBanner", () => {
  it("shows when an update is available and not dismissed", () => {
    expect(shouldShowClaudeCliBanner(base, null)).toBe(true);
  });

  it("hides once the current latest version is dismissed", () => {
    expect(shouldShowClaudeCliBanner(base, "2.1.220")).toBe(false);
  });

  it("re-shows for a version newer than the dismissed one (per-version dismissal)", () => {
    const newer = { ...base, latest_version: "2.1.221" };
    expect(shouldShowClaudeCliBanner(newer, "2.1.220")).toBe(true);
  });

  it("hides when no update is available", () => {
    expect(shouldShowClaudeCliBanner({ ...base, update_available: false }, null)).toBe(false);
  });

  it("hides when status is null or the latest version is unknown", () => {
    expect(shouldShowClaudeCliBanner(null, null)).toBe(false);
    expect(shouldShowClaudeCliBanner({ ...base, latest_version: null }, null)).toBe(false);
  });
});
